#pragma once
#include "config.h"
#include "pid.h"

// 工艺位号（与组态工程一致）
//   P101  给水泵         —— 只能手动给开度（用户要求）
//   FV101 给水总阀（泵后）—— 单回路 LIC103 的操纵变量；自动=回路输出，手动=手操值
//   FV102 级间阀 T1->T2   —— 手动
//   FV103 级间阀 T2->T3   —— 手动
//   FV104 出口阀 T3->池   —— 手动
//   LI101/102/103 液位指示；LIC101/102/103 液位控制器
//   FI101 给水流量（泵出口/总阀后）；FI102 级间流量 T1->T2；PI101 泵出口压力
//
// ---- 用户自搭回路（单回路方案）----
//   pv: 0=LI101 / 1=LI102 / 2=LI103（被控量=液位 %FS）；mv: 0=FV101 / 1=FV102 / 2=FV103 / 3=FV104
//   SP 按液位共享：两只回路用同一液位时 SP 是同一份数据（改一个另一个跟着变）
struct LoopCfg {
    int  pv, mv;
    PID  pid;
    bool enabled;
};
// ---- 串级回路（串级方案）：阀门 + 主环 + 副环 ----
//   mv    : 0=FV101 / 1=FV102 / 2=FV103 / 3=FV104（只能选阀门）
//   outer : 主环被控量  0..2=液位 LI101..103 / 3..5=流量 FI101..103
//   inner : 副环被控量，编码同上
//   主环输出(0..100)作为副环给定；副环输出(0..100)作为阀门开度
struct CascCfg {
    int  mv;
    int  outer, inner;
    PID  opid, ipid;
    bool enabled;
};
struct TankSystem {
    // Levels: engineering mm (0..1000), display %
    double h1, h2, h3;              // mm
    double h1_meas, h2_meas, h3_meas; // mm after sensor lag
    // Actuators
    double pump;                    // P101 开度 %
    double valve_in;                // FV101 给水总阀（泵后）%
    double valve_12;                // FV102 T1->T2 %
    double valve_23;                // FV103 T2->T3 %
    double valve_out;               // FV104 T3->排水池 %
    // Flows: engineering L/min
    double qin, q12, q23, qout, q_overflow;
    // Instruments (display)
    double pi101_kpa;               // PI101 泵出口压力 kPa
    // Setpoints: level % of full scale (0-100)
    double setpoint;                // primary SP (h3 for A/B)
    double sp1, sp2, sp3;           // 各罐液位设定值（%FS）
    int    mode;                    // LoopMode 0=单回路 / 1=串级
    int    cascade_master;          // 串级方案主控罐：0=T1(LIC101) / 1=T2(LIC102) / 2=T3(LIC103)
    double mst_out_cmd;             // 串级：主控罐出口阀手操开度 %（主控=T3 时不用，走 valve_out_cmd）
    int    cs_master_prev;          // 内部：主控罐变化检测（-1=未应用）
    LoopCfg loop[MAX_LOOPS];         // 单回路：用户自搭回路（默认 0 只）
    int    nLoop;                    // 已搭建回路数
    LoopCfg loop_other[MAX_LOOPS];   // 另一方案的独立单回路配置，避免单回路/串级互相残留
    int    nLoop_other;
    int    loop_other_mode;          // loop_other 对应的方案：-1=空 / MODE_A / MODE_B
    CascCfg casc[MAX_CASC];          // 串级：用户自搭串级（阀门+主环+副环，默认 0 条）
    int    nCasc;                    // 已搭建串级数
    double spf[3];                   // 流量被控量 SP（%FS，主环为流量时用）
    double vhand[N_MV];              // FV101..FV104 手操开度 %（未被回路占用的阀由它驱动）
    int    needRecalcLoops;          // 内部：回路增删/改方向后需重做无扰偏置
    bool   running;                 // 启动按钮门控：False = 一切静止，不推进仿真
    bool   paused;
    bool   noise_enable;
    double noise_state[3];           // 测量噪声状态（%FS），一阶相关，不进入真实液位
    double sim_time;
    int    n;
    // Diagnostics
    int    overflow_count;
    double overflow_volume_l;       // L
    double underflow_count;         // times h was forced to 0
    int    overflow_flag;           // 内部：本主步是否发生过溢流（子步置位，主步计数）
    int    underflow_flag;          // 内部：本主步是否发生过欠排
    double balance_err[3];          // % volume balance error per tank (running)
    // Internal SI states (m, m^3/s) and actuator lag states
    double hs[3];                   // m
    double hmeas[3];                // m
    double pump_cmd;                // % commanded
    double valve_in_cmd;
    double valve_out_cmd;
    double valve_12_cmd;
    double valve_23_cmd;
    double q_pump;                  // m^3/s actual after lag
    double vol_in[3];               // cumulative m^3 in
    double vol_out[3];              // cumulative m^3 out
    double vol0[3];                 // initial volume m^3
    // Controllers
    PID lic101, lic102, lic103;
    PID fic101;                     // cascade inner (B)
    double last_sp_a, last_sp_b;    // feedforward SP-change detect
    double last_valve_a;            // valve FF detect
    // History (display units)
    double t_hist[MAX_POINTS];
    double h1_hist[MAX_POINTS], h2_hist[MAX_POINTS], h3_hist[MAX_POINTS];
    double sp_hist[MAX_POINTS], mv_hist[MAX_POINTS];
    double sp_loop_hist[MAX_LOOPS][MAX_POINTS];   // 每条控制回路各自的 SP 轨迹（显示口径 mm）
    // 流量历史（曲线页「流量/开度」组用；记录不参与任何动力学计算）
    double qin_hist[MAX_POINTS], q12_hist[MAX_POINTS];
    double q23_hist[MAX_POINTS], qout_hist[MAX_POINTS];
    // 执行机构开度历史（流量/开度曲线独立分组后使用）
    double pump_hist[MAX_POINTS];
    double vin_hist[MAX_POINTS], v12_hist[MAX_POINTS];
    double v23_hist[MAX_POINTS], vout_hist[MAX_POINTS];
};

void InitSimulation(TankSystem* s);
void UpdateSimulation(TankSystem* s);           // 1 s main step (10 substeps)
void UpdateSimulationSub(TankSystem* s, double dt_sub); // expose for selftest
void RunControlStep(TankSystem* s, double dt);  // PID once per main step
double GravityPipeQ(int pipe, double head_m, double opening_pct); // m^3/s
double TankAreaM2();
void ApplyPidGains(TankSystem* s);              // scheme-dependent defaults
void ApplyCascadeGains(TankSystem* s);          // 串级(B)：按主控/非主控角色整定并做无扰偏置
double CascadeMasterBias(const TankSystem* s);  // 当前主控罐的解析稳态前馈（% 泵可用流量）

// ---- 回路 i (0=LIC101/T1, 1=LIC102/T2, 2=LIC103/T3) 在当前方案下的操纵变量 ----
//   A 单回路: T1->FV102 级间阀1 | T2->FV103 级间阀2 | T3->FV101 给水总阀
//   B 串级  : 每条串级按用户搭建的阀门、主环、副环驱动
inline double* LoopMvCmd(TankSystem* s, int i) {
    if (s->mode == MODE_B) {
        // 串级方案：单回路各用自己搭建的阀（串级本身另有 casc[]）
        const int k = (i < 0) ? 0 : (i >= MAX_LOOPS ? MAX_LOOPS - 1 : i);
        switch (s->loop[k].mv) {
            case 0:  return &s->valve_in_cmd;
            case 1:  return &s->valve_12_cmd;
            case 2:  return &s->valve_23_cmd;
            default: return &s->valve_out_cmd;
        }
    }
    return (i == 0) ? &s->valve_12_cmd : (i == 1 ? &s->valve_23_cmd : &s->valve_in_cmd);
}
inline double LoopMvValue(const TankSystem* s, int i) {
    if (s->mode == MODE_B) {
        const int k = (i < 0) ? 0 : (i >= MAX_LOOPS ? MAX_LOOPS - 1 : i);
        switch (s->loop[k].mv) {
            case 0:  return s->valve_in;
            case 1:  return s->valve_12;
            case 2:  return s->valve_23;
            default: return s->valve_out;
        }
    }
    return (i == 0) ? s->valve_12 : (i == 1 ? s->valve_23 : s->valve_in);
}
// 本罐出口阀当前阀位（串级 B 中非主控罐的操纵变量；主控罐该阀为手操）
inline double OutletValveValue(const TankSystem* s, int i) {
    return (i == 0) ? s->valve_12 : (i == 1 ? s->valve_23 : s->valve_out);
}
// 本罐出口阀命令字段（主控罐的出口阀在串级下由手操框驱动）
inline double* OutletValveCmd(TankSystem* s, int i) {
    return (i == 0) ? &s->valve_12_cmd : (i == 1 ? &s->valve_23_cmd : &s->valve_out_cmd);
}

// ============================================================
// 用户自搭回路（单回路）API
// ============================================================
const wchar_t* PvTag(int pv);        // LI101 / LI102 / LI103
const wchar_t* PvTankTag(int pv);    // 1#罐液位 / 2#罐液位 / 3#罐液位
const wchar_t* MvTag(int mv);        // FV101 / FV102 / FV103 / FV104
double* ValveCmdP(TankSystem* s, int mv);
double  ValveVal(const TankSystem* s, int mv);
double  LevelPct(const TankSystem* s, int pv);
double  SpPct(const TankSystem* s, int pv);
double* SpPctP(TankSystem* s, int pv);   // SP 按液位共享：同一液位的两只回路指向同一份数据
double  LoopFeedforward(const TankSystem* s, const LoopCfg* L);
int     LoopDefaultAction(int pv, int mv);
void    LoopApplyDefaults(TankSystem* s, LoopCfg* L);
// LoopAdd：成功返回新回路下标；失败返回 LoopAddResult 负值
enum LoopAddResult {
    LOOP_ADD_FULL = -1,        // 回路数量已达上限
    LOOP_ADD_DUPLICATE = -2,    // 同一液位控制同一阀门的回路重复
    LOOP_ADD_MV_CONFLICT = -3   // 同一阀门已被另一液位回路占用
};
int     LoopAdd(TankSystem* s, int pv, int mv);
void    LoopDel(TankSystem* s, int idx);
void    LoopClear(TankSystem* s);
void    SwitchLoopConfigMode(TankSystem* s, int newMode);
void    ApplyRecommendedLoops(TankSystem* s);
void    ApplyHighScoreTemplate(TankSystem* s);
void    SyncHandFromValves(TankSystem* s);
// 当前方案下驱动该阀的回路：-1=手操，0..3=回路下标，100=串级（单回路外的固定回路）
int     ValveDriver(const TankSystem* s, int mv);
int     LoopsInUse(const TankSystem* s);           // 当前方案的有效回路数（界面/PID 页用）

// ============================================================
// 被控量选择器（液位 + 流量统一编码）0..2=液位 LI101..103 / 3..5=流量 FI101..103
// ============================================================
const wchar_t* PvxTag(int sel);     // LI101.. / FI101..
const wchar_t* PvxKindTag(int sel); // 「液位」 / 「流量」
const wchar_t* PvxTankTag(int sel); // 「1#罐液位」 / 「给水流量」
bool   PvxIsFlow(int sel);
double PvxValue(const TankSystem* s, int sel);    // 液位=%FS / 流量=%FS（对 Q_PUMP_MAX）
double PvxSp(const TankSystem* s, int sel);
double* PvxSpP(TankSystem* s, int sel);
double PvxFlowLmin(const TankSystem* s, int flowIdx);   // FI101/102/103 实测 L/min

// ============================================================
// 用户自搭串级（阀门 + 主环 + 副环）API
// ============================================================
enum CascAddResult {
    CASC_ADD_FULL = -1,        // 串级数量已达上限
    CASC_ADD_DUPLICATE = -2,   // 同阀门/同主环/同副环的重复串级
    CASC_ADD_MV_CONFLICT = -3  // 阀门已被另一条串级或单回路占用
};
int  CascAdd(TankSystem* s, int mv, int outer, int inner);
void CascDel(TankSystem* s, int idx);
void CascClear(TankSystem* s);
void ApplyCascadeTemplate(TankSystem* s);   // 推荐串级模板：1 条串级 + T1/T2 两条单回路
int  CascadeMasterTankOf(const TankSystem* s);   // 主环为液位时对应的罐号 0..2，否则 -1
