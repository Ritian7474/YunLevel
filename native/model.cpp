#include "model.h"
#include <cmath>
#include <cstdlib>

double TankAreaM2() {
    double d = TANK_D_MM * MM2M; // m
    return PI_C * d * d / 4.0;   // m^2
}

double GravityPipeQ(int pipe, double head_m, double opening_pct) {
    if (pipe < 0 || pipe >= 3) return 0.0;
    return pipe_hydraulics::flow(GRAVITY_PIPES[pipe], head_m, opening_pct);
}

static double clampd(double v, double lo, double hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

// 前向声明：串级整定函数位于文件后半部分，但被 ApplyCascadeGains 使用
struct CascCfg;
static int clampi(int v, int lo, int hi);
static double CascOuterBias(const TankSystem* s, const CascCfg* C);
static void CascApplyDefaults(TankSystem* s, CascCfg* C);

static double lag_step(double x, double y, double tau, double dt) {
    if (tau <= 1e-9) return x;
    double a = dt / (tau + dt);
    return (1.0 - a) * y + a * x;
}

static double rate_limit(double cmd, double cur, double rate_pct_per_s, double dt) {
    double max_d = rate_pct_per_s * dt;
    double d = cmd - cur;
    if (d > max_d) d = max_d;
    if (d < -max_d) d = -max_d;
    return cur + d;
}

static void ResetLoopCfg(LoopCfg* L) {
    if (!L) return;
    L->pv = 0;
    L->mv = 0;
    L->enabled = false;
    PidInit(&L->pid);
    L->pid.manual = true;
    L->pid.manual_out = 0.0;
}

static void CopyLoopCfg(LoopCfg* dst, const LoopCfg* src) {
    *dst = *src;
}

void ApplyPidGains(TankSystem* s) {
    if (!s) return;
    PidInit(&s->lic103);
    s->lic103.Kp = 0.35;
    s->lic103.Ti = PID_TI_OFF;
    s->lic103.Td = 120.0;  // TASK-010: keep Codex-mandated Td=120
    // FV101 is the inlet valve: low level must open it, so this is reverse action.
    s->lic103.action = -1;
    s->lic103.out_min = 0.0;
    s->lic103.out_max = 100.0;

    // 单回路：LIC101 调 FV102 级间阀1（1#罐液位，阀在罐出口，响应稍快）
    PidInit(&s->lic101);
    s->lic101.Kp = 0.50;
    s->lic101.Ti = PID_TI_OFF;
    s->lic101.Td = 60.0;
    // FV102 is the outlet valve: rising level must open it, so this is direct action.
    s->lic101.action = 1;
    s->lic101.out_min = 0.0;
    s->lic101.out_max = 100.0;

    // 单回路：LIC102 调 FV103 级间阀2（2#罐液位）
    PidInit(&s->lic102);
    s->lic102.Kp = 0.45;
    s->lic102.Ti = PID_TI_OFF;
    s->lic102.Td = 90.0;
    // FV103 is the outlet valve: rising level must open it, so this is direct action.
    s->lic102.action = 1;
    s->lic102.out_min = 0.0;
    s->lic102.out_max = 100.0;

    PidInit(&s->fic101);
    s->fic101.Kp = 1.0;
    s->fic101.Ti = 8.0;
    s->fic101.Td = 1.0;
    // Flow error positive means more flow required: reverse action opens FV101.
    s->fic101.action = -1;
    s->fic101.out_min = 0.0;
    s->fic101.out_max = 100.0;
}

// ============================================================
// 串级（MODE_B）接线与整定
//   主环：主控罐液位 LIC10x（输出 = 给水流量给定 %FS）  action=-1（液位低 → 加流量）
//   副环：FIC101 给水流量 FI101 → FV101 给水总阀          action=-1（流量低 → 开阀）
//   其余罐：本罐液位 → 本罐出口阀（单回路）              action=+1（液位高 → 开阀排液）
// 每次只有一只罐做主控（cascade_master）：其余阀门 FV102/103/104 只做单回路或手操，不参与串级。
// ============================================================

// 当前给水流量占“泵可用流量”的百分比（主环输出的工程口径）
// 主环稳态前馈：把主控罐液位稳在 SP 所需的给水流量（% 泵可用流量）
//   稳态时 q_in = q_out = 本罐出口管路在目标液位和当前阀位下的流量
static double cascade_ff(const TankSystem* s, int k) {
    double qav = clampd(s->pump, 0.0, 100.0) / 100.0 * Q_PUMP_MAX_LMIN;   // L/min
    if (qav < 1e-9) return 0.0;
    double sp = (k == 0) ? s->sp1 : (k == 1 ? s->sp2 : s->sp3);
    double v_out = clampd(OutletValveValue(s, k), 0.0, 100.0) / 100.0;
    double q_need = GravityPipeQ(k, sp / 100.0 * TANK_H_MM * MM2M,
        v_out * 100.0) * M3S2LMIN;
    return clampd(q_need / qav * 100.0, 0.0, 100.0);
}


void ApplyCascadeGains(TankSystem* s) {
    if (!s) return;
    // 串级（用户搭建）：主环 / 副环按当前组态重设整定，并以当前工况做无扰偏置
    for (int c = 0; c < s->nCasc; ++c) {
        if (!s->casc[c].enabled) continue;
        CascCfg* C = &s->casc[c];
        const bool    om  = C->opid.manual;  const double omv = C->opid.manual_out;
        const bool    im  = C->ipid.manual;  const double imv = C->ipid.manual_out;
        CascApplyDefaults(s, C);
        C->opid.manual = om; C->opid.manual_out = omv;
        C->ipid.manual = im; C->ipid.manual_out = imv;
        PidReset(&C->opid, CascOuterBias(s, C));
        PidReset(&C->ipid, ValveVal(s, C->mv));
    }
    // 单回路（串级方案下也可搭建）：按当前工况重做前馈工作点
    for (int i = 0; i < s->nLoop; ++i) {
        if (!s->loop[i].enabled) continue;
        PidReset(&s->loop[i].pid, LoopFeedforward(s, &s->loop[i]));
    }
    const int mt = CascadeMasterTankOf(s);
    if (mt >= 0) s->cascade_master = mt;
    s->cs_master_prev = clampi(s->cascade_master, 0, 2);
}

double CascadeMasterBias(const TankSystem* s) {
    if (!s) return 0.0;
    const int k = (s->cascade_master < 0) ? 0 : (s->cascade_master > 2 ? 2 : s->cascade_master);
    return cascade_ff(s, k);
}

void InitSimulation(TankSystem* s) {
    if (!s) return;
    const double A = TankAreaM2();
    s->h1 = 0.0; s->h2 = 0.0; s->h3 = 0.0;       // mm 初始三罐空（用户要求）
    s->hs[0] = s->h1 * MM2M;
    s->hs[1] = s->h2 * MM2M;
    s->hs[2] = s->h3 * MM2M;
    s->h1_meas = s->h1; s->h2_meas = s->h2; s->h3_meas = s->h3;
    s->hmeas[0] = s->hs[0]; s->hmeas[1] = s->hs[1]; s->hmeas[2] = s->hs[2];
    s->pump = 0.0;
    s->valve_in = 0.0;
    s->valve_out = 0.0;
    s->valve_12 = 0.0;
    s->valve_23 = 0.0;
    s->pump_cmd = 0.0;
    s->valve_in_cmd = 0.0;
    s->valve_out_cmd = 0.0;
    s->valve_12_cmd = 0.0;
    s->valve_23_cmd = 0.0;
    s->pi101_kpa = 0.0;
    s->running = false;          // 需点击「启动」后才开始运算
    s->q_pump = 0.0;
    s->qin = 0.0; s->q12 = 0.0; s->q23 = 0.0; s->qout = 0.0; s->q_overflow = 0.0;
    s->setpoint = 30.0;
    s->sp1 = 30.0; s->sp2 = 30.0; s->sp3 = 30.0;
    s->mode = MODE_A;
    s->cascade_master = 2;       // 串级默认主控罐 = T3（LIC103，与单回路里驱动 FV101 的那只回路一致）
    s->mst_out_cmd = 0.0;
    s->cs_master_prev = -1;
    // 用户自搭回路（单回路）：默认 0 只（用户要求）；手操值全 0；一切静止
    s->nLoop = 0;
    s->needRecalcLoops = 0;
    s->nLoop_other = 0;
    s->loop_other_mode = -1;
    s->nCasc = 0;
    s->spf[0] = s->spf[1] = s->spf[2] = 50.0;
    for (int i = 0; i < MAX_CASC; ++i) {
        s->casc[i].mv = 0; s->casc[i].outer = 2; s->casc[i].inner = 3;
        s->casc[i].enabled = false;
        PidInit(&s->casc[i].opid);
        PidInit(&s->casc[i].ipid);
        s->casc[i].opid.manual = true;  s->casc[i].opid.manual_out = 0.0;
        s->casc[i].ipid.manual = true;  s->casc[i].ipid.manual_out = 0.0;
    }
    for (int i = 0; i < MAX_LOOPS; ++i) {
        ResetLoopCfg(&s->loop[i]);
        ResetLoopCfg(&s->loop_other[i]);
    }
    for (int v = 0; v < N_MV; ++v) s->vhand[v] = 0.0;
    s->paused = false;
    s->noise_enable = false;
    s->noise_state[0] = s->noise_state[1] = s->noise_state[2] = 0.0;
    s->sim_time = 0.0;
    s->n = 0;
    s->overflow_count = 0;
    s->overflow_volume_l = 0.0;
    s->underflow_count = 0.0;
    s->overflow_flag = 0;
    s->underflow_flag = 0;
    s->balance_err[0] = s->balance_err[1] = s->balance_err[2] = 0.0;
    s->vol0[0] = s->hs[0] * A;
    s->vol0[1] = s->hs[1] * A;
    s->vol0[2] = s->hs[2] * A;
    s->vol_in[0] = s->vol_in[1] = s->vol_in[2] = 0.0;
    s->vol_out[0] = s->vol_out[1] = s->vol_out[2] = 0.0;
    s->last_sp_a = s->last_sp_b = -1e9;
    s->last_valve_a = 100.0;
    ApplyPidGains(s);
    // Bias near expected operating point for bumpless start
    PidReset(&s->lic103, 0.0);
    PidReset(&s->lic101, 0.0);
    PidReset(&s->lic102, 0.0);
    PidReset(&s->fic101, 0.0);
    // 初始三只回路均为手动、输出 0%：三罐无水、泵阀全关，一切静止（用户要求）
    s->lic101.manual = true; s->lic101.manual_out = 0.0;
    s->lic102.manual = true; s->lic102.manual_out = 0.0;
    s->lic103.manual = true; s->lic103.manual_out = 0.0;
    for (int i = 0; i < MAX_POINTS; ++i) {
        s->t_hist[i] = 0.0;
        s->h1_hist[i] = 0.0;
        s->h2_hist[i] = 0.0;
        s->h3_hist[i] = 0.0;
        s->sp_hist[i] = 0.0;
        s->mv_hist[i] = 0.0;
        for (int k = 0; k < MAX_LOOPS; ++k) s->sp_loop_hist[k][i] = 0.0;
        s->qin_hist[i] = 0.0;
        s->q12_hist[i] = 0.0;
        s->q23_hist[i] = 0.0;
        s->qout_hist[i] = 0.0;
        s->pump_hist[i] = 0.0;
        s->vin_hist[i] = 0.0;
        s->v12_hist[i] = 0.0;
        s->v23_hist[i] = 0.0;
        s->vout_hist[i] = 0.0;
    }
}

// ============================================================
// 用户自搭回路（单回路）：位号表 / 阀门存取 / 前馈 / 增删
// ============================================================
static int clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

const wchar_t* PvTag(int pv) {
    static const wchar_t* t[N_PV] = { L"LI101", L"LI102", L"LI103" };
    return t[clampi(pv, 0, N_PV - 1)];
}
const wchar_t* PvTankTag(int pv) {
    static const wchar_t* t[N_PV] = { L"1#罐液位", L"2#罐液位", L"3#罐液位" };
    return t[clampi(pv, 0, N_PV - 1)];
}
const wchar_t* MvTag(int mv) {
    static const wchar_t* t[N_MV] = { L"FV101", L"FV102", L"FV103", L"FV104" };
    return t[clampi(mv, 0, N_MV - 1)];
}
// ---- 被控量选择器：0..2=液位 LI101..103 | 3..5=流量 FI101..103 ----
const wchar_t* PvxTag(int sel) {
    static const wchar_t* t[N_PVX] = { L"LI101", L"LI102", L"LI103", L"FI101", L"FI102", L"FI103" };
    return t[clampi(sel, 0, N_PVX - 1)];
}
const wchar_t* PvxKindTag(int sel) {
    return PvxIsFlow(sel) ? L"\u6d41\u91cf" : L"\u6db2\u4f4d";
}
const wchar_t* PvxTankTag(int sel) {
    static const wchar_t* lv[N_PV] = { L"1#\u7f50\u6db2\u4f4d", L"2#\u7f50\u6db2\u4f4d", L"3#\u7f50\u6db2\u4f4d" };
    static const wchar_t* fl[3]  = { L"\u7ed9\u6c34\u6d41\u91cf", L"\u7ea7\u95f41\u6d41\u91cf", L"\u7ea7\u95f42\u6d41\u91cf" };
    const int s = clampi(sel, 0, N_PVX - 1);
    return (s < N_PV) ? lv[s] : fl[s - N_PV];
}
double* ValveCmdP(TankSystem* s, int mv) {
    switch (clampi(mv, 0, N_MV - 1)) {
        case 0:  return &s->valve_in_cmd;
        case 1:  return &s->valve_12_cmd;
        case 2:  return &s->valve_23_cmd;
        default: return &s->valve_out_cmd;
    }
}
double ValveVal(const TankSystem* s, int mv) {
    switch (clampi(mv, 0, N_MV - 1)) {
        case 0:  return s->valve_in;
        case 1:  return s->valve_12;
        case 2:  return s->valve_23;
        default: return s->valve_out;
    }
}
double LevelPct(const TankSystem* s, int pv) {
    const double mm = (pv == 0) ? s->h1_meas : (pv == 1 ? s->h2_meas : s->h3_meas);
    return mm / L_MAX_MM * 100.0;
}
double SpPct(const TankSystem* s, int pv) {
    return (pv == 0) ? s->sp1 : (pv == 1 ? s->sp2 : s->sp3);
}
double* SpPctP(TankSystem* s, int pv) {
    return (pv == 0) ? &s->sp1 : (pv == 1 ? &s->sp2 : &s->sp3);
}
bool PvxIsFlow(int sel) { return clampi(sel, 0, N_PVX - 1) >= N_PV; }
// FI101/FI102/FI103 实测流量 L/min
double PvxFlowLmin(const TankSystem* s, int flowIdx) {
    switch (clampi(flowIdx, 0, 2)) {
        case 0:  return s->qin;
        case 1:  return s->q12;
        default: return s->q23;
    }
}
// 统一到 %FS：液位=%罐高；流量=%泵最大流量 Q_PUMP_MAX_LMIN
double PvxValue(const TankSystem* s, int sel) {
    const int k = clampi(sel, 0, N_PVX - 1);
    if (k < N_PV) return LevelPct(s, k);
    return clampd(PvxFlowLmin(s, k - N_PV) / Q_PUMP_MAX_LMIN * 100.0, -200.0, 200.0);
}
double PvxSp(const TankSystem* s, int sel) {
    const int k = clampi(sel, 0, N_PVX - 1);
    return (k < N_PV) ? SpPct(s, k) : s->spf[k - N_PV];
}
double* PvxSpP(TankSystem* s, int sel) {
    const int k = clampi(sel, 0, N_PVX - 1);
    return (k < N_PV) ? SpPctP(s, k) : &s->spf[k - N_PV];
}

// 阀 mv 是不是本罐 pv 的进口阀 / 出口阀
//   进口：T1<-FV101  T2<-FV102  T3<-FV103    出口：T1->FV102  T2->FV103  T3->FV104
static bool is_inlet_of(int mv, int pv)  { return mv == pv; }
static bool is_outlet_of(int mv, int pv) { return mv == pv + 1; }

int LoopDefaultAction(int pv, int mv) {
    if (is_inlet_of(mv, pv))  return -1;   // 液位低要开进口阀：反作用
    if (is_outlet_of(mv, pv)) return +1;   // 液位高要开出口阀：正作用
    return -1;                             // 非本罐进/出口路径：按常见调节阀默认反作用，可手动改
}

double LoopFeedforward(const TankSystem* s, const LoopCfg* L) {
    if (!s || !L) return 0.0;
    const int pv = clampi(L->pv, 0, N_PV - 1), mv = clampi(L->mv, 0, N_MV - 1);
    // 稳态物料平衡（对任意 PV×MV 组态都成立）：
    //   本罐要稳在 SP，就必须让“本罐出料” q_target 稳定流出；
    //   该阀无论装在本罐进口、本罐出口，还是更远的上/下游，稳态流量都等于 q_target。
    //   进口泵阀按流量比例反算；重力管路按同一水力方程反算阀位。
    const double q_avail = clampd(s->pump, 0.0, 100.0) / 100.0 * Q_PUMP_MAX_LMIN * LMIN2M3S;
    const double v_out[N_PV] = { clampd(s->valve_12,  0.0, 100.0) / 100.0,   // T1 出口阀 FV102
                                 clampd(s->valve_23,  0.0, 100.0) / 100.0,   // T2 出口阀 FV103
                                 clampd(s->valve_out, 0.0, 100.0) / 100.0 };
    const double spm[N_PV] = { s->sp1, s->sp2, s->sp3 };
    const double v_in01 = clampd(s->valve_in, 0.0, 100.0) / 100.0;
    // 该阀稳态必须通过的流量 q_need：
    //   ① 该阀就是本罐出口阀（mv == pv+1）：Qout = Qin，用本罐实测进料 → 扰动立即反映，任何液位下都精确；
    //   ② 其它情况（阀装在本罐进口，或更远的上/下游）：按 SP 反算本罐稳态出料量。
    double q_need;
    if (mv == pv + 1) {
        const double q_in = (pv == 0) ? (q_avail * v_in01)
                                     : GravityPipeQ(pv - 1, s->hs[pv - 1], v_out[pv - 1] * 100.0);
        q_need = q_in;
    } else {
        q_need = GravityPipeQ(pv, spm[pv] / 100.0 * TANK_H_MM * MM2M,
            v_out[pv] * 100.0);
    }
    // FV101 受泵可用量限制；其余阀用目标液位对应的水头反算。
    if (mv == 0) {
        if (q_avail < 1e-12) return 0.0;
        return clampd(q_need / q_avail * 100.0, 0.0, 100.0);
    }
    return pipe_hydraulics::opening_for_flow(GRAVITY_PIPES[mv - 1],
        spm[mv - 1] / 100.0 * TANK_H_MM * MM2M, q_need);
}

void LoopApplyDefaults(TankSystem* s, LoopCfg* L) {
    if (!s || !L) return;
    L->pv = clampi(L->pv, 0, N_PV - 1);
    L->mv = clampi(L->mv, 0, N_MV - 1);
    PID* p = &L->pid;
    PidInit(p);
    // 整定按被控罐取档（与原有单回路一致）
    if (L->pv == 0)      { p->Kp = 0.50; p->Ti = PID_TI_OFF; p->Td = 60.0; }
    else if (L->pv == 1) { p->Kp = 0.45; p->Ti = PID_TI_OFF; p->Td = 90.0; }
    else                 { p->Kp = 0.35; p->Ti = PID_TI_OFF; p->Td = 120.0; }
    p->action = LoopDefaultAction(L->pv, L->mv);
    p->out_min = 0.0; p->out_max = 100.0;
    p->manual = false;                 // 新建回路默认投自动
    p->manual_out = 0.0;
    L->enabled = true;
    PidReset(p, LoopFeedforward(s, L));   // 无扰起手：以当前工况的解析前馈为工作点
}

int LoopAdd(TankSystem* s, int pv, int mv) {
    if (!s) return LOOP_ADD_FULL;
    if (s->nLoop >= MAX_LOOPS) return LOOP_ADD_FULL;
    if (s->mode == MODE_B && s->nCasc + s->nLoop >= MAX_LOOPS) return LOOP_ADD_FULL;
    const int npv = clampi(pv, 0, N_PV - 1);
    const int nmv = clampi(mv, 0, N_MV - 1);
    for (int i = 0; i < s->nLoop; ++i) {
        if (s->loop[i].pv != npv || s->loop[i].mv != nmv) continue;
        // 完全相同的液位→阀门组合只保留一条。
        return LOOP_ADD_DUPLICATE;
    }
    for (int i = 0; i < s->nLoop; ++i) {
        // 同一执行阀只能由一个液位控制器驱动；同一液位控制不同阀仍允许。
        if (s->loop[i].mv == nmv) return LOOP_ADD_MV_CONFLICT;
    }
    // 串级方案下：阀门是全系统独占资源，串级已占的阀不能再搭单回路
    if (s->mode == MODE_B) {
        for (int c = 0; c < s->nCasc; ++c)
            if (s->casc[c].enabled && s->casc[c].mv == nmv) return LOOP_ADD_MV_CONFLICT;
    }
    LoopCfg* L = &s->loop[s->nLoop];
    L->pv = npv;
    L->mv = nmv;
    LoopApplyDefaults(s, L);
    s->nLoop++;
    s->needRecalcLoops = 1;
    return s->nLoop - 1;
}
void LoopDel(TankSystem* s, int idx) {
    if (!s || idx < 0 || idx >= s->nLoop) return;
    for (int i = idx; i + 1 < s->nLoop; ++i) s->loop[i] = s->loop[i + 1];
    s->nLoop--;
    s->needRecalcLoops = 1;
}
void LoopClear(TankSystem* s) {
    if (!s) return;
    s->nLoop = 0;
    s->needRecalcLoops = 1;
}
// 单回路页和串级页各自保存一套单回路配置；切换时只交换当前方案要用的那一套。
void SwitchLoopConfigMode(TankSystem* s, int newMode) {
    if (!s) return;
    if (s->running) return;   // UI 已禁止；模型层同样拒绝运行中切方案
    newMode = clampi(newMode, MODE_A, MODE_B);
    if (newMode == s->mode) return;

    LoopCfg saved[MAX_LOOPS];
    const int savedN = s->nLoop;
    for (int i = 0; i < savedN && i < MAX_LOOPS; ++i)
        CopyLoopCfg(&saved[i], &s->loop[i]);

    if (s->loop_other_mode == newMode) {
        s->nLoop = s->nLoop_other;
        for (int i = 0; i < s->nLoop; ++i)
            CopyLoopCfg(&s->loop[i], &s->loop_other[i]);
    } else {
        s->nLoop = 0;
        for (int i = 0; i < MAX_LOOPS; ++i) ResetLoopCfg(&s->loop[i]);
    }

    s->nLoop_other = savedN;
    for (int i = 0; i < savedN && i < MAX_LOOPS; ++i)
        CopyLoopCfg(&s->loop_other[i], &saved[i]);
    s->loop_other_mode = s->mode;
    s->mode = newMode;
    s->needRecalcLoops = 1;
}
void ApplyRecommendedLoops(TankSystem* s) {
    if (!s) return;
    LoopClear(s);
    LoopAdd(s, 0, 1);   // LI101 1#罐液位 → FV102 级间阀1
    LoopAdd(s, 1, 2);   // LI102 2#罐液位 → FV103 级间阀2
    LoopAdd(s, 2, 0);   // LI103 3#罐液位 → FV101 给水总阀
    s->needRecalcLoops = 1;
}
void SyncHandFromValves(TankSystem* s) {
    if (!s) return;
    for (int v = 0; v < N_MV; ++v) s->vhand[v] = ValveVal(s, v);
}

// ============================================================
// 用户自搭串级（阀门 + 主环 + 副环）
// ============================================================
int CascadeMasterTankOf(const TankSystem* s) {
    if (!s) return -1;
    for (int c = 0; c < s->nCasc; ++c)
        if (s->casc[c].enabled && !PvxIsFlow(s->casc[c].outer)) return s->casc[c].outer;
    return -1;
}

// 主环稳态前馈：主环为液位时用该液位→该阀的解析工作点；流量主环不设前馈
static double CascOuterBias(const TankSystem* s, const CascCfg* C) {
    if (!s || !C) return 0.0;
    if (PvxIsFlow(C->outer)) return 0.0;
    LoopCfg L;
    L.pv = clampi(C->outer, 0, N_PV - 1);
    L.mv = clampi(C->mv, 0, N_MV - 1);
    L.enabled = true;
    PidInit(&L.pid);
    return LoopFeedforward(s, &L);
}

static void CascApplyDefaults(TankSystem* s, CascCfg* C) {
    if (!s || !C) return;
    C->mv    = clampi(C->mv, 0, N_MV - 1);
    C->outer = clampi(C->outer, 0, N_PVX - 1);
    C->inner = clampi(C->inner, 0, N_PVX - 1);
    PID* po = &C->opid;
    PidInit(po);
    if (PvxIsFlow(C->outer)) { po->Kp = 1.0; po->Ti = 8.0; po->Td = 1.0; po->action = -1; }
    else {
        const int lv = C->outer;
        if      (lv == 0) { po->Kp = 0.50; po->Ti = PID_TI_OFF; po->Td = 60.0; }
        else if (lv == 1) { po->Kp = 0.45; po->Ti = PID_TI_OFF; po->Td = 90.0; }
        else              { po->Kp = 0.35; po->Ti = PID_TI_OFF; po->Td = 120.0; }
        po->action = LoopDefaultAction(lv, C->mv);
    }
    po->out_min = 0.0; po->out_max = 100.0; po->manual = false; po->manual_out = 0.0;
    PID* pi = &C->ipid;
    PidInit(pi);
    if (PvxIsFlow(C->inner)) { pi->Kp = 1.0; pi->Ti = 8.0; pi->Td = 1.0; pi->action = -1; }
    else {
        const int lv = C->inner;
        if      (lv == 0) { pi->Kp = 0.50; pi->Ti = PID_TI_OFF; pi->Td = 60.0; }
        else if (lv == 1) { pi->Kp = 0.45; pi->Ti = PID_TI_OFF; pi->Td = 90.0; }
        else              { pi->Kp = 0.35; pi->Ti = PID_TI_OFF; pi->Td = 120.0; }
        pi->action = LoopDefaultAction(lv, C->mv);
    }
    pi->out_min = 0.0; pi->out_max = 100.0; pi->manual = false; pi->manual_out = 0.0;
    C->enabled = true;
    PidReset(po, CascOuterBias(s, C));
    PidReset(pi, ValveVal(s, C->mv));
}

int CascAdd(TankSystem* s, int mv, int outer, int inner) {
    if (!s || s->mode != MODE_B) return CASC_ADD_FULL;
    if (s->nCasc >= MAX_CASC) return CASC_ADD_FULL;
    if (s->nCasc + s->nLoop >= MAX_LOOPS) return CASC_ADD_FULL;   // 串级 + 单回路共用卡位上限
    const int nmv = clampi(mv, 0, N_MV - 1);
    const int no  = clampi(outer, 0, N_PVX - 1);
    const int ni  = clampi(inner, 0, N_PVX - 1);
    for (int c = 0; c < s->nCasc; ++c) {
        if (!s->casc[c].enabled) continue;
        if (s->casc[c].mv == nmv && s->casc[c].outer == no && s->casc[c].inner == ni)
            return CASC_ADD_DUPLICATE;
    }
    for (int c = 0; c < s->nCasc; ++c)
        if (s->casc[c].enabled && s->casc[c].mv == nmv) return CASC_ADD_MV_CONFLICT;
    for (int i = 0; i < s->nLoop; ++i)
        if (s->loop[i].enabled && s->loop[i].mv == nmv) return CASC_ADD_MV_CONFLICT;
    CascCfg* C = &s->casc[s->nCasc];
    C->mv = nmv; C->outer = no; C->inner = ni;
    CascApplyDefaults(s, C);
    s->nCasc++;
    s->needRecalcLoops = 1;
    return s->nCasc - 1;
}
void CascDel(TankSystem* s, int idx) {
    if (!s || idx < 0 || idx >= s->nCasc) return;
    for (int i = idx; i + 1 < s->nCasc; ++i) s->casc[i] = s->casc[i + 1];
    s->nCasc--;
    s->needRecalcLoops = 1;
}
void CascClear(TankSystem* s) {
    if (!s) return;
    s->nCasc = 0;
    s->needRecalcLoops = 1;
}
// 推荐串级模板：FV101 + LI103 主环 + FI101 副环，并补齐 T1/T2 两条单回路，保证三只液位都有闭环。
void ApplyCascadeTemplate(TankSystem* s) {
    if (!s) return;
    CascClear(s);
    LoopClear(s);
    CascAdd(s, 0, 2, 3);   // FV101 给水总阀 + LI103 液位主环 + FI101 流量副环
    LoopAdd(s, 0, 1);      // LI101 -> FV102 级间阀1，T1 液位闭环
    LoopAdd(s, 1, 2);      // LI102 -> FV103 级间阀2，T2 液位闭环
    s->needRecalcLoops = 1;
}

void ApplyHighScoreTemplate(TankSystem* s) {
    if (!s) return;
    s->sp1 = s->sp2 = s->sp3 = 50.0;
    s->setpoint = 50.0;
    s->spf[0] = s->spf[1] = s->spf[2] = 50.0;
    // 泵开度 60%：给水能力 12 L/min，实际出水需求由各段管路阻力计算，留调节余量，
    // 又不会像泵满开那样强推入口，避免首罐/二罐在建立液位阶段大幅超调。
    s->pump_cmd = 60.0;
    s->mst_out_cmd = 100.0;
    if (s->mode == MODE_B) ApplyCascadeTemplate(s);
    else                   ApplyRecommendedLoops(s);

    for (int i = 0; i < s->nLoop; ++i) {
        LoopCfg& L = s->loop[i];
        L.pid.manual = false;
        PidReset(&L.pid, LoopFeedforward(s, &L));
    }
    for (int c = 0; c < s->nCasc; ++c) {
        CascCfg& C = s->casc[c];
        C.opid.manual = false;
        C.ipid.manual = false;
        PidReset(&C.opid, CascOuterBias(s, &C));
        PidReset(&C.ipid, ValveVal(s, C.mv));
    }
    for (int v = 0; v < N_MV; ++v) {
        if (ValveDriver(s, v) < 0) {
            s->vhand[v] = 100.0;
            *ValveCmdP(s, v) = 100.0;
        }
    }
    s->needRecalcLoops = 1;
}

int ValveDriver(const TankSystem* s, int mv) {
    if (!s) return -1;
    mv = clampi(mv, 0, N_MV - 1);
    if (s->mode == MODE_A) {
        for (int i = 0; i < s->nLoop; ++i)
            if (s->loop[i].enabled && s->loop[i].mv == mv) return i;
        return -1;
    }
    if (s->mode == MODE_B) {
        // 串级方案：阀门由用户搭建的串级或单回路占用；没占用就是手操
        for (int c = 0; c < s->nCasc; ++c)
            if (s->casc[c].enabled && s->casc[c].mv == mv) return 300 + c;
        for (int i = 0; i < s->nLoop; ++i)
            if (s->loop[i].enabled && s->loop[i].mv == mv) return i;
        return -1;
    }
    return -1;
}

int LoopsInUse(const TankSystem* s) {
    if (!s) return 0;
    if (s->mode == MODE_B) {
        int nc = 0;
        for (int c = 0; c < s->nCasc; ++c) if (s->casc[c].enabled) nc++;
        int nl = 0;
        for (int i = 0; i < s->nLoop; ++i) if (s->loop[i].enabled) nl++;
        return nc + nl;
    }
    int n = 0;
    for (int i = 0; i < s->nLoop; ++i) if (s->loop[i].enabled) n++;
    return n;
}

void RunControlStep(TankSystem* s, double dt) {
    if (!s) return;
    // 串级(B)：主控罐变更时按新角色重设增益与无扰偏置
    if (s->mode == MODE_B) {
        const int k = (s->cascade_master < 0) ? 0 : (s->cascade_master > 2 ? 2 : s->cascade_master);
        if (k != s->cs_master_prev) ApplyCascadeGains(s);
    } else {
    s->cs_master_prev = -1;
    }
    // 单回路旧控制器的默认作用方向；串级作用方向写在每条串级自己的 PID 中
    if (s->mode == MODE_A) {
        s->lic101.action = 1;
        s->lic102.action = 1;
        s->lic103.action = -1;
    }
    // 泵开度（P101 手动）决定的可用给水量；泵没开时阀开到底也没有流量
    double q_avail = (clampd(s->pump, 0.0, 100.0) / 100.0) * Q_PUMP_MAX_LMIN * LMIN2M3S;
    const double q_avail_lmin = q_avail * M3S2LMIN;   // 泵可用给水量 L/min（主环输出 0-100% 的工程量程）

    // 回路驱动：手动 -> 手动输出值；自动 -> PID + 前馈偏置
    // 偏置跟踪：与目标差得远（>5%）直接置位，否则 5 s 一阶跟踪，避免无扰切换时跳动
    // 偏置跟踪：与目标差得远（>5%）直接置位，否则 1 s 一阶跟踪，避免无扰切换时跳动
    auto step_pid = [&](PID* p, double sp, double pv, double ff) -> double {
        if (!p->manual) {
            const double tau_bias = 1.0;
            const double a = dt / (tau_bias + dt);
            if (std::fabs(ff - p->u_bias) > 5.0) p->u_bias = ff;
            else p->u_bias = (1.0 - a) * p->u_bias + a * ff;
            p->u_bias = clampd(p->u_bias, p->out_min, p->out_max);
        }
        return PidStep(p, sp, pv, dt);
    };
    auto drive = [&](PID* p, double sp, double pv, double ff, double* cmd) {
        *cmd = step_pid(p, sp, pv, ff);
    };

    if (s->mode == MODE_A) {
        // 单回路（本方案）：完全按用户搭建的回路驱动，回路数可 0..4，不分主副回路
        // ① 未被任何回路占用的执行器（含 P101）由手操值驱动
        for (int v = 0; v < N_MV; ++v) {
            if (ValveDriver(s, v) < 0) *ValveCmdP(s, v) = clampd(s->vhand[v], 0.0, 100.0);
        }
        // ② 回路增删/改方向后重做无扰偏置（以当前工况的解析前馈为工作点）
        if (s->needRecalcLoops) {
            for (int i = 0; i < s->nLoop; ++i)
                PidReset(&s->loop[i].pid, LoopFeedforward(s, &s->loop[i]));
            s->needRecalcLoops = 0;
        }
        // ③ 各回路：手动 -> 手动输出；自动 -> PID(SP 按液位共享) + 前馈偏置
        for (int i = 0; i < s->nLoop; ++i) {
            LoopCfg* L = &s->loop[i];
            if (!L->enabled) continue;
            drive(&L->pid, SpPct(s, L->pv), LevelPct(s, L->pv),
                  LoopFeedforward(s, L), ValveCmdP(s, L->mv));
        }
        // 曲线页 SP 轨迹：有回路就取第一只回路的被控量 SP，无回路保持上一次值
        if (s->nLoop > 0) s->setpoint = SpPct(s, s->loop[0].pv);
    } else {
        // ==================== 串级（用户自由搭建）====================
        //   每条串级：主环（液位/流量）→ 副环（流量/液位）→ 阀门
        //   同页可共存用户搭建的单回路（液位 → 阀门）；阀门全系统独占
        for (int v = 0; v < N_MV; ++v)
            if (ValveDriver(s, v) < 0) *ValveCmdP(s, v) = clampd(s->vhand[v], 0.0, 100.0);

        if (s->needRecalcLoops) {
            for (int i = 0; i < s->nLoop; ++i) if (s->loop[i].enabled)
                PidReset(&s->loop[i].pid, LoopFeedforward(s, &s->loop[i]));
            for (int c = 0; c < s->nCasc; ++c) if (s->casc[c].enabled)
                PidReset(&s->casc[c].ipid, ValveVal(s, s->casc[c].mv));
            s->needRecalcLoops = 0;
        }

        // 串级：主环输出（0..100）作为副环给定，副环输出作为阀门开度
        for (int c = 0; c < s->nCasc; ++c) {
            CascCfg* C = &s->casc[c];
            if (!C->enabled) continue;
            if (C->opid.manual) {
                // 主环手动：手动输出直接作为副环给定（副环跟随、不积分、不饱和）
                C->ipid.manual = true;
                C->ipid.manual_out = clampd(C->opid.manual_out, 0.0, 100.0);
                *ValveCmdP(s, C->mv) = PidStep(&C->ipid, 0.0, 0.0, dt);
            } else {
                C->ipid.manual = false;
                const double u_outer = step_pid(&C->opid, PvxSp(s, C->outer),
                                                PvxValue(s, C->outer), CascOuterBias(s, C));
                double sp_inner, pv_inner;
                if (PvxIsFlow(C->inner)) {
                    sp_inner = u_outer / 100.0 * q_avail_lmin;        // L/min
                    pv_inner = PvxFlowLmin(s, C->inner - N_PV);
                } else {
                    sp_inner = u_outer;                               // %FS
                    pv_inner = PvxValue(s, C->inner);
                }
                *ValveCmdP(s, C->mv) = PidStep(&C->ipid, sp_inner, pv_inner, dt);
            }
        }

        // 同页单回路：本罐液位 → 本阀
        for (int i = 0; i < s->nLoop; ++i) {
            LoopCfg* L = &s->loop[i];
            if (!L->enabled) continue;
            drive(&L->pid, SpPct(s, L->pv), LevelPct(s, L->pv),
                  LoopFeedforward(s, L), ValveCmdP(s, L->mv));
        }
        if (s->nCasc > 0)      s->setpoint = PvxSp(s, s->casc[0].outer);
        else if (s->nLoop > 0) s->setpoint = SpPct(s, s->loop[0].pv);
    }
}

static void plant_substep(TankSystem* s, double dt) {
    const double A = TankAreaM2();
    const double Hmax = TANK_H_MM * MM2M;

    // Actuator dynamics (pump first-order + rate limit on command)
    s->pump = rate_limit(clampd(s->pump_cmd, 0.0, 100.0), s->pump, 100.0 / 1.0, dt);
    double pump_open = clampd(s->pump, 0.0, 100.0);
    double q_pump_target = (pump_open / 100.0) * Q_PUMP_MAX_LMIN * LMIN2M3S;
    s->q_pump = lag_step(q_pump_target, s->q_pump, T_PUMP_S, dt);

    s->valve_in = rate_limit(clampd(s->valve_in_cmd, 0.0, 100.0), s->valve_in, VALVE_RATE_PCT_S, dt);
    s->valve_out = rate_limit(clampd(s->valve_out_cmd, 0.0, 100.0), s->valve_out, VALVE_RATE_PCT_S, dt);
    s->valve_12 = rate_limit(clampd(s->valve_12_cmd, 0.0, 100.0), s->valve_12, VALVE_RATE_PCT_S, dt);
    s->valve_23 = rate_limit(clampd(s->valve_23_cmd, 0.0, 100.0), s->valve_23, VALVE_RATE_PCT_S, dt);

    // Flows (SI)
    double q12 = GravityPipeQ(0, s->hs[0], s->valve_12);
    double q23 = GravityPipeQ(1, s->hs[1], s->valve_23);
    double qout = GravityPipeQ(2, s->hs[2], s->valve_out);
    double qin = s->q_pump * (s->valve_in / 100.0);   // FV101 给水总阀节流

    // Conservative empty-tank boundary: a numerical substep cannot drain more
    // water than is stored plus the inflow during that same substep.
    auto available_outflow = [&](double candidate, double inflow, double level) {
        const double available = inflow + std::max(0.0, level) * A / dt;
        if (candidate > available) s->underflow_flag = 1;
        return std::min(candidate, available);
    };
    q12 = available_outflow(q12, qin, s->hs[0]);
    q23 = available_outflow(q23, q12, s->hs[1]);
    qout = available_outflow(qout, q23, s->hs[2]);

    // PI101 泵出口压力（简化理想泵特性 H = H0*n^2 - k*q^2，kPa）
    // 注意：q 取"阀后实际流量"qin —— 阀门关小时流量减小、扬程沿泵曲线上抬，
    // 关死时到 shut-off 扬程。本量仅用于显示，不参与任何积分或控制。
    double Hp = H_PUMP_SHUTOFF_M * pump_open * pump_open / 10000.0
              - PUMP_HEAD_K * qin * qin;
    s->pi101_kpa = (Hp > 0.0) ? (9.81 * Hp) : 0.0;

    // Integrate levels
    s->hs[0] += (qin - q12) / A * dt;
    s->hs[1] += (q12 - q23) / A * dt;
    s->hs[2] += (q23 - qout) / A * dt;

    // Underflow
    for (int i = 0; i < 3; ++i) {
        if (s->hs[i] < 0.0) {
            s->hs[i] = 0.0;
            s->underflow_flag = 1;
        }
    }
    // Overflow protection
    double qov = 0.0;
    if (s->hs[2] > Hmax) {
        double excess = s->hs[2] - Hmax;
        qov = excess * A / dt; // m^3/s equivalent
        s->hs[2] = Hmax;
        s->overflow_flag = 1;
        s->overflow_volume_l += excess * A * 1000.0; // m^3 -> L
        s->vol_out[2] += excess * A;
    }
    if (s->hs[1] > Hmax) {
        double excess = s->hs[1] - Hmax;
        s->hs[1] = Hmax;
        s->overflow_flag = 1;
        s->overflow_volume_l += excess * A * 1000.0;
        s->vol_out[1] += excess * A;
    }
    if (s->hs[0] > Hmax) {
        double excess = s->hs[0] - Hmax;
        s->hs[0] = Hmax;
        s->overflow_flag = 1;
        s->overflow_volume_l += excess * A * 1000.0;
        s->vol_out[0] += excess * A;
    }

    // Track volumes for balance check
    s->vol_in[0] += qin * dt;
    s->vol_out[0] += q12 * dt;
    s->vol_in[1] += q12 * dt;
    s->vol_out[1] += q23 * dt;
    s->vol_in[2] += q23 * dt;
    s->vol_out[2] += qout * dt;

    // Sensor lag
    for (int i = 0; i < 3; ++i) {
        s->hmeas[i] = lag_step(s->hs[i], s->hmeas[i], TAU_SENSOR_S, dt);
    }

    // Display flows L/min
    s->qin = qin * M3S2LMIN;
    s->q12 = q12 * M3S2LMIN;
    s->q23 = q23 * M3S2LMIN;
    s->qout = qout * M3S2LMIN;
    s->q_overflow = qov * M3S2LMIN;

    s->h1 = s->hs[0] * M2MM;
    s->h2 = s->hs[1] * M2MM;
    s->h3 = s->hs[2] * M2MM;
    s->h1_meas = s->hmeas[0] * M2MM;
    s->h2_meas = s->hmeas[1] * M2MM;
    s->h3_meas = s->hmeas[2] * M2MM;

    // Balance error % of tank volume
    for (int i = 0; i < 3; ++i) {
        double acc = s->vol_in[i] - s->vol_out[i] - (s->hs[i] * A - s->vol0[i]);
        double V = s->hs[i] * A;
        if (V > 1e-9) s->balance_err[i] = acc / V * 100.0;
    }
}

void UpdateSimulationSub(TankSystem* s, double dt_sub) {
    if (!s) return;
    plant_substep(s, dt_sub);
}

static void HistoryDecimate(TankSystem* s) {
    if (!s || s->n <= 0) return;
    int dst = 0;
    for (int src = 0; src < s->n; src += 2, ++dst) {
        s->t_hist[dst] = s->t_hist[src];
        s->h1_hist[dst] = s->h1_hist[src];
        s->h2_hist[dst] = s->h2_hist[src];
        s->h3_hist[dst] = s->h3_hist[src];
        s->sp_hist[dst] = s->sp_hist[src];
        for (int k = 0; k < MAX_LOOPS; ++k)
            s->sp_loop_hist[k][dst] = s->sp_loop_hist[k][src];
        s->mv_hist[dst] = s->mv_hist[src];
        s->qin_hist[dst] = s->qin_hist[src];
        s->q12_hist[dst] = s->q12_hist[src];
        s->q23_hist[dst] = s->q23_hist[src];
        s->qout_hist[dst] = s->qout_hist[src];
        s->pump_hist[dst] = s->pump_hist[src];
        s->vin_hist[dst] = s->vin_hist[src];
        s->v12_hist[dst] = s->v12_hist[src];
        s->v23_hist[dst] = s->v23_hist[src];
        s->vout_hist[dst] = s->vout_hist[src];
    }
    s->n = dst;
}

static void HistoryAppend(TankSystem* s) {
    if (!s) return;
    if (s->n >= MAX_POINTS) HistoryDecimate(s);
    int i = s->n;
    s->t_hist[i] = s->sim_time;
    s->h1_hist[i] = s->h1;
    s->h2_hist[i] = s->h2;
    s->h3_hist[i] = s->h3;
    // 曲线页 SP 轨迹与液位同轴（mm）：setpoint 为 %FS，需换算，否则 SP 线会画到轴底
    s->sp_hist[i] = s->setpoint / 100.0 * L_MAX_MM;
    for (int k = 0; k < MAX_LOOPS; ++k) s->sp_loop_hist[k][i] = 0.0;
    if (s->mode == MODE_A) {
        for (int k = 0; k < s->nLoop && k < MAX_LOOPS; ++k)
            s->sp_loop_hist[k][i] = SpPct(s, s->loop[k].pv) / 100.0 * L_MAX_MM;
    } else {
        int k = 0;
        for (int c = 0; c < s->nCasc && k < MAX_LOOPS; ++c) {
            if (!s->casc[c].enabled) continue;
            s->sp_loop_hist[k++][i] = PvxSp(s, s->casc[c].outer) / 100.0 * L_MAX_MM;
        }
        for (int q = 0; q < s->nLoop && k < MAX_LOOPS; ++q) {
            if (!s->loop[q].enabled) continue;
            s->sp_loop_hist[k++][i] = SpPct(s, s->loop[q].pv) / 100.0 * L_MAX_MM;
        }
    }
    s->mv_hist[i] = s->pump;
    s->qin_hist[i] = s->qin;
    s->q12_hist[i] = s->q12;
    s->q23_hist[i] = s->q23;
    s->qout_hist[i] = s->qout;
    s->pump_hist[i] = s->pump;
    s->vin_hist[i] = s->valve_in;
    s->v12_hist[i] = s->valve_12;
    s->v23_hist[i] = s->valve_23;
    s->vout_hist[i] = s->valve_out;
    s->n = i + 1;
}

void UpdateSimulation(TankSystem* s) {
    if (!s) return;
    if (!s->running) return;      // 未点「启动」：一切静止，时间与状态都不推进
    if (s->paused) return;
    // Control once per main 1 s step, then 10 plant substeps
    RunControlStep(s, DT_MAIN_S);
    for (int i = 0; i < SUBSTEPS; ++i) {
        plant_substep(s, DT_SUB_S);
    }
    // 仪表噪声只叠加在测量值上，不改变真实液位；按主步做一阶相关，避免 0.1 s 白噪声式跳变。
    if (s->noise_enable) {
        const double a = DT_MAIN_S / (NOISE_TAU_S + DT_MAIN_S);
        for (int i = 0; i < 3; ++i) {
            const double white = ((double)std::rand() / RAND_MAX - 0.5) * 2.0 * NOISE_PCT_FS;
            s->noise_state[i] = (1.0 - a) * s->noise_state[i] + a * white;
        }
        s->h1_meas = clampd(s->h1_meas + s->noise_state[0] / 100.0 * L_MAX_MM, 0.0, L_MAX_MM);
        s->h2_meas = clampd(s->h2_meas + s->noise_state[1] / 100.0 * L_MAX_MM, 0.0, L_MAX_MM);
        s->h3_meas = clampd(s->h3_meas + s->noise_state[2] / 100.0 * L_MAX_MM, 0.0, L_MAX_MM);
    } else {
        s->noise_state[0] = s->noise_state[1] = s->noise_state[2] = 0.0;
    }
    s->sim_time += DT_MAIN_S;
    if (s->overflow_flag) {
        s->overflow_count += 1;
        s->overflow_flag = 0;
    }
    if (s->underflow_flag) {
        s->underflow_count += 1.0;
        s->underflow_flag = 0;
    }
    HistoryAppend(s);
}
