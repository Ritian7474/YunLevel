#include "score.h"
#include <algorithm>
#include <cmath>
#include <cstring>

ScoreState g_score;

static double clampd_s(double v, double lo, double hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

static double level_pct(const TankSystem* s, int pv) {
    const double mm = (pv == 0) ? s->h1_meas : (pv == 1 ? s->h2_meas : s->h3_meas);
    return clampd_s(mm / L_MAX_MM * 100.0, 0.0, 100.0);
}

static double true_level_pct(const TankSystem* s, int pv) {
    const double mm = (pv == 0) ? s->h1 : (pv == 1 ? s->h2 : s->h3);
    return clampd_s(mm / L_MAX_MM * 100.0, 0.0, 100.0);
}

static double level_sp(const TankSystem* s, int pv) {
    return (pv == 0) ? s->sp1 : (pv == 1 ? s->sp2 : s->sp3);
}

static bool tank_has_control(const TankSystem* s, int pv) {
    if (!s) return false;
    for (int i = 0; i < s->nLoop; ++i)
        if (s->loop[i].enabled && s->loop[i].pv == pv) return true;
    for (int c = 0; c < s->nCasc; ++c)
        if (s->casc[c].enabled && s->casc[c].outer == pv) return true;
    return false;
}

static bool tank_all_auto(const TankSystem* s, int pv) {
    if (!s) return false;
    int n = 0;
    for (int i = 0; i < s->nLoop; ++i) {
        if (!s->loop[i].enabled || s->loop[i].pv != pv) continue;
        n++;
        if (s->loop[i].pid.manual) return false;
    }
    for (int c = 0; c < s->nCasc; ++c) {
        if (!s->casc[c].enabled || s->casc[c].outer != pv) continue;
        n++;
        if (s->casc[c].opid.manual || s->casc[c].ipid.manual) return false;
    }
    return n > 0;
}

static bool has_cascade(const TankSystem* s) {
    if (!s) return false;
    for (int c = 0; c < s->nCasc; ++c)
        if (s->casc[c].enabled) return true;
    return false;
}

static void push_error(int pv, double e) {
    ScoreState& q = g_score;
    q.err_win[pv][q.err_head[pv]] = e;
    q.err_head[pv] = (q.err_head[pv] + 1) % 300;
    if (q.err_count[pv] < 300) q.err_count[pv]++;
}

static double mae_pct(int pv) {
    const ScoreState& q = g_score;
    if (q.err_count[pv] <= 0) return 0.0;
    double sum = 0.0;
    for (int i = 0; i < q.err_count[pv]; ++i) sum += q.err_win[pv][i];
    return sum / q.err_count[pv];
}

static double settle_score(double t, double full) {
    if (t < 0.0) return 0.0;
    if (t <= 180.0) return full;
    if (t <= 300.0) return full * 0.80;
    if (t <= 600.0) return full * 0.5333333333;
    if (t <= 900.0) return full * 0.20;
    return 0.0;
}

static double overshoot_score(double os_pct, double full) {
    if (os_pct <= 1.0) return full;
    if (os_pct <= 2.0) return full * 0.80;
    if (os_pct <= 5.0) return full * 0.50;
    if (os_pct <= 10.0) return full * 0.20;
    return 0.0;
}

static ScoreCategory make_category(double op, double target, double ctrl, double ben, double deduction) {
    ScoreCategory c;
    c.operation = clampd_s(op, 0.0, 25.0);
    c.target = clampd_s(target, 0.0, 40.0);
    c.control = clampd_s(ctrl, 0.0, 80.0);
    c.safety = 0.0;
    c.benefit = clampd_s(ben, 0.0, 30.0);
    c.safety_deduction = clampd_s(deduction, 0.0, 20.0);
    c.total = clampd_s(c.operation + c.target + c.control + c.benefit - c.safety_deduction, 0.0, 100.0);
    return c;
}

double ScoreSessionDuration() {
    const double u = (g_score.dur_unit_s > 1.0) ? g_score.dur_unit_s : SCORE_DURATION_UNIT;
    const double y = (g_score.dur_sys_s > 1.0) ? g_score.dur_sys_s : SCORE_DURATION_SYSTEM;
    return (g_score.mode == SCORE_SYSTEM) ? y : u;
}

void ScoreSetConfig(double dur_unit, double dur_sys, double band_tank, double band_hx,
                    double dist_at, int dist_mv, double dist_delta) {
    if (dur_unit > 1.0) g_score.dur_unit_s = dur_unit;
    if (dur_sys > 1.0) g_score.dur_sys_s = dur_sys;
    if (band_tank > 0.01) g_score.band_tank_pct = band_tank;
    if (band_hx > 0.01) g_score.band_hx_c = band_hx;
    ScoreSetDisturb(dist_at, dist_mv, dist_delta);
}

void ScoreSetDisturb(double at_s, int mv, double delta_pct) {
    g_score.disturb_enable = true;
    g_score.disturb_at_s = at_s;
    g_score.disturb_mv = (mv < 0) ? 0 : (mv > 3 ? 3 : mv);
    g_score.disturb_delta = clampd_s(delta_pct, -100.0, 100.0);
    g_score.disturb_fired = false;
    g_score.disturb_recovered = false;
}

double ScoreBandTailRatio(int pv) {
    if (pv < 0 || pv > 2) return 0.0;
    const double w = g_score.band_tail_window;
    if (w <= 1e-9) return 0.0;
    return clampd_s(g_score.band_tail_time[pv] / w, 0.0, 1.0);
}

static void reset_run_data(bool begin) {
    ScoreState& q = g_score;
    for (int i = 0; i < 3; ++i) q.band_tail_time[i] = 0.0;
    q.band_tail_window = 0.0;
    q.band_tail_init = false;
    q.disturb_fired = false;
    q.disturb_applied = false;
    q.disturb_recovered = false;
    q.disturb_recover_s = -1.0;
    q.auto_time[0] = q.auto_time[1] = q.auto_time[2] = -1.0;
    q.run_begin = begin;
    q.control_active = false;
    q.run_t = 0.0;
    q.active_t = 0.0;
    q.start_t = -1.0;
    q.start_latch = false;
    for (int i = 0; i < 3; ++i) {
        q.built_latch[i] = false;
        q.auto_latch[i] = false;
        q.settle_latch[i] = false;
        q.settle_time[i] = -1.0;
        q.settle_hold[i] = 0.0;
        q.max_level[i] = 0.0;
        q.err_head[i] = 0;
        q.err_count[i] = 0;
        q.low_active[i] = false;
        q.armed[i] = false;
        q.high_active[i] = false;
        q.low_time[i] = 0.0;
        q.high_time[i] = 0.0;
        q.overflow_latch[i] = false;
        q.dry_latch[i] = false;
        q.overflow_events[i] = 0;
        q.dry_events[i] = 0;
        q.outflow_volume_l[i] = 0.0;
        q.inflow_volume_l[i] = 0.0;
        q.ref_outflow_volume_l[i] = 0.0;
        memset(q.err_win[i], 0, sizeof(q.err_win[i]));
        q.tank_score[i] = TankScore{};
    }
    q.feed_volume_l = 0.0;
    q.flow_balance_sum = 0.0;
    q.flow_balance_n = 0;
    q.inner_err_sum_pct = 0.0;
    q.inner_err_n = 0;
    q.system_score = SystemScore{};
}

void ScoreInit() {
    // 必须先 memset 再写默认值，否则带宽会被清成 0，整定判定 e<=0 永不成立
    memset(&g_score, 0, sizeof(g_score));
    g_score.dur_unit_s = SCORE_DURATION_UNIT;
    g_score.dur_sys_s = SCORE_DURATION_SYSTEM;
    g_score.band_tank_pct = 2.0;
    g_score.band_hx_c = 5.0;
    g_score.mode = SCORE_OFF;
    g_score.tank = 2;
    reset_run_data(false);
}

void ScoreColdReset() {
    const ScoreMode mode = g_score.mode;
    const int tank = g_score.tank;
    // Keep configuration separate from the runtime reset without changing the persisted struct.
    const double du = g_score.dur_unit_s, ds = g_score.dur_sys_s;
    const double bt = g_score.band_tank_pct, bh = g_score.band_hx_c;
    const bool disturb = g_score.disturb_enable;
    const double at = g_score.disturb_at_s, delta = g_score.disturb_delta;
    const int mv = g_score.disturb_mv;
    ScoreInit();
    g_score.mode = mode;
    g_score.tank = (tank < 0 || tank > 2) ? 2 : tank;
    g_score.dur_unit_s = du; g_score.dur_sys_s = ds;
    g_score.band_tank_pct = bt; g_score.band_hx_c = bh;
    g_score.disturb_enable = disturb;
    g_score.disturb_at_s = at; g_score.disturb_delta = delta; g_score.disturb_mv = mv;
}

void ScoreBeginSession() {
    reset_run_data(true);
    g_score.session_active = true;
    g_score.session_t = 0.0;
    g_score.session_finished = false;
    g_score.session_just_end = false;
}

void ScoreEndSession() {
    g_score.session_active = false;
    g_score.session_t = 0.0;
    g_score.session_finished = false;
    g_score.session_just_end = false;
}

bool ScoreSessionActive() { return g_score.session_active; }
void ScoreFinishSession() {
    if (!g_score.session_active) return;
    g_score.session_active = false;
    g_score.session_finished = true;
    g_score.session_just_end = true;
    for (auto& tank : g_score.tank_score) tank.cat = {};
    g_score.system_score.cat = {};
}
double ScoreSessionTime() { return g_score.session_t; }
bool ScoreSessionFinished() { return g_score.session_finished; }

bool ScoreTakeFinishedEvent() {
    const bool ev = g_score.session_just_end;
    g_score.session_just_end = false;
    return ev;
}

void ScoreBeginRun(const TankSystem* s) {
    (void)s;
    reset_run_data(g_score.mode != SCORE_OFF);
    // 计分与计时都由「开始评分」会话驱动：只选方案不会自动开始评分。
}

bool ScoreCanSwitch(const TankSystem* s) {
    return s && !s->running;
}

void ScoreSetMode(ScoreMode mode) {
    if (mode < SCORE_OFF || mode > SCORE_SYSTEM) mode = SCORE_OFF;
    if (g_score.mode == mode) return;
    g_score.mode = mode;
    reset_run_data(false);
}

void ScoreCycleMode() {
    const int next = ((int)g_score.mode + 1) % 3;
    ScoreSetMode((ScoreMode)next);
}

void ScoreCycleTank() {
    if (g_score.mode != SCORE_TANK) return;
    g_score.tank = (g_score.tank + 1) % 3;
    reset_run_data(false);
}

const wchar_t* ScoreModeText(ScoreMode mode) {
    switch (mode) {
        case SCORE_TANK:   return L"单罐";
        case SCORE_SYSTEM: return L"系统";
        default:           return L"关";
    }
}

const wchar_t* ScoreTankText(int tank) {
    static const wchar_t* t[3] = { L"LI101", L"LI102", L"LI103" };
    return t[(tank < 0 || tank > 2) ? 2 : tank];
}

static double safety_deduction_one_tank(const TankSystem* s, int pv) {
    (void)s;
    const ScoreState& q = g_score;
    const double d_low = clampd_s(2.0 * std::floor(q.low_time[pv] / 60.0), 0.0, 10.0);
    const double d_high = clampd_s(2.0 * std::floor(q.high_time[pv] / 60.0), 0.0, 10.0);
    const double d_of = clampd_s(5.0 * q.overflow_events[pv], 0.0, 10.0);
    const double d_dry = clampd_s(5.0 * q.dry_events[pv], 0.0, 10.0);
    return clampd_s(d_low + d_high + d_of + d_dry, 0.0, 20.0);
}

static double flow_balance_score(double eq_lmin, double full) {
    if (eq_lmin <= 0.2) return full;
    return full * clampd_s(1.0 - (eq_lmin - 0.2) / 1.8, 0.0, 1.0);
}

static double inner_loop_mae_pct() {
    if (g_score.inner_err_n <= 0) return 0.0;
    return g_score.inner_err_sum_pct / g_score.inner_err_n;
}

static void update_tank_reports(const TankSystem* s) {
    ScoreState& q = g_score;
    for (int pv = 0; pv < 3; ++pv) {
        TankScore& t = q.tank_score[pv];
        t.loop_built = tank_has_control(s, pv);
        t.loop_auto = tank_all_auto(s, pv);
        t.mae_pct = mae_pct(pv);
        t.settled = q.settle_latch[pv];
        t.settle_s = q.settle_latch[pv] ? q.settle_time[pv] : -1.0;
        const double os = q.max_level[pv] - level_sp(s, pv);
        t.overshoot_pct = os > 0.0 ? os : 0.0;
        t.low_time_s = q.low_time[pv];
        t.high_time_s = q.high_time[pv];
        t.overflow_events = q.overflow_events[pv];
        t.dry_events = q.dry_events[pv];
        t.outflow_l = q.outflow_volume_l[pv];
        const double in_l = q.inflow_volume_l[pv];
        t.efficiency = (in_l > 1e-9) ? clampd_s(q.outflow_volume_l[pv] / in_l, 0.0, 2.0) : 0.0;

        // 操作 25：起步5 + 建立流通5 + 按时投自动10 + 按时稳态5（分步给分）
        double op = q.start_latch ? 5.0 : 0.0;
        op += q.built_latch[pv] ? 5.0 : 0.0;
        if (q.auto_latch[pv]) {
            op += (q.auto_time[pv] <= 150.0) ? 10.0 : (q.auto_time[pv] <= 300.0 ? 5.0 : 0.0);
        }
        if (q.settle_latch[pv] && q.settle_time[pv] <= 600.0) op += 5.0;

        // 尾段目标范围 40
        const double target = 40.0 * ScoreBandTailRatio(pv);

        // 控制品质 35：MAE20 + 超调15
        double ctrl = 0.0;
        if (q.built_latch[pv] && q.auto_latch[pv]) {
            ctrl += 20.0 * clampd_s(1.0 - t.mae_pct / 5.0, 0.0, 1.0);
            ctrl += 15.0 * clampd_s(1.0 - t.overshoot_pct / 10.0, 0.0, 1.0);
        }

        // 安全倒扣；液位不计收益
        const double deduction = safety_deduction_one_tank(s, pv);
        const double ben = 0.0;
        t.cat = make_category(op, target, ctrl, ben, deduction);
    }
}

static void update_system_report(const TankSystem* s) {
    ScoreState& q = g_score;
    SystemScore& y = q.system_score;
    y.all_built = true;
    y.all_auto = true;
    for (int pv = 0; pv < 3; ++pv) {
        y.all_built = y.all_built && q.built_latch[pv];
        y.all_auto = y.all_auto && q.auto_latch[pv];
    }

    double op = q.start_latch ? 5.0 : 0.0;
    op += y.all_built ? 5.0 : 0.0;
    if (y.all_auto) op += 8.0;
    op += (y.sync_settle_s >= 0.0 && y.sync_settle_s <= 300.0) ? 7.0 : 0.0;
    // clamp operation to 20 for system
    op = clampd_s(op, 0.0, 20.0);

    y.sync_settle_s = 0.0;
    bool all_settled = true;
    for (int pv = 0; pv < 3; ++pv) {
        if (!q.settle_latch[pv]) {
            all_settled = false;
            break;
        }
        if (q.settle_time[pv] > y.sync_settle_s) y.sync_settle_s = q.settle_time[pv];
    }
    if (all_settled && y.sync_settle_s <= 600.0) op += 5.0;

    double ctrl = 0.0;
    for (int pv = 0; pv < 3; ++pv) {
        if (!q.built_latch[pv] || !q.auto_latch[pv]) continue;
        ctrl += 10.0 * clampd_s(1.0 - q.tank_score[pv].mae_pct / 5.0, 0.0, 1.0);
    }
    if (y.all_built && y.all_auto && all_settled)
        ctrl += settle_score(y.sync_settle_s, 10.0);

    y.flow_balance_lmin = (q.flow_balance_n > 0) ? q.flow_balance_sum / q.flow_balance_n : 0.0;
    y.inner_mae_pct = inner_loop_mae_pct();
    if (has_cascade(s)) {
        ctrl += flow_balance_score(y.flow_balance_lmin, 5.0);
        ctrl += 5.0 * clampd_s(1.0 - y.inner_mae_pct / 5.0, 0.0, 1.0);
    } else {
        ctrl += flow_balance_score(y.flow_balance_lmin, 10.0);
    }

    // 尾段目标范围（系统）：三罐同时在带占比 60% + 平均 40%
    double rho_all = 1.0;
    double rho_sum = 0.0;
    for (int pv = 0; pv < 3; ++pv) {
        const double r = ScoreBandTailRatio(pv);
        rho_all = (r > 0.0 ? (rho_all * (r >= 0.999 ? 1.0 : r)) : 0.0);
        rho_sum += r;
    }
    // 简化：用 min(rho) 近似同时在带
    double rho_min = ScoreBandTailRatio(0);
    for (int pv = 1; pv < 3; ++pv) {
        const double r = ScoreBandTailRatio(pv);
        if (r < rho_min) rho_min = r;
    }
    const double rho_avg = rho_sum / 3.0;
    const double target = 30.0 * clampd_s(0.6 * rho_min + 0.4 * rho_avg, 0.0, 1.0);

    // 扰动恢复 25（教师可配；未触发则按 0）
    double disturb = 0.0;
    if (q.disturb_enable && q.disturb_fired) {
        if (q.disturb_recovered && q.disturb_recover_s >= 0.0) {
            const double t_r = q.disturb_recover_s;
            if (t_r <= 120.0) disturb = 10.0;
            else if (t_r <= 180.0) disturb = 8.0;
            else if (t_r <= 240.0) disturb = 5.0;
            else if (t_r <= 360.0) disturb = 2.0;
            // 峰值偏离 8：用 max MAE 近似
            const double peak = std::max(q.tank_score[0].mae_pct,
                                  std::max(q.tank_score[1].mae_pct, q.tank_score[2].mae_pct));
            if (peak <= 3.0) disturb += 8.0;
            else if (peak <= 6.0) disturb += 5.0;
            else if (peak <= 10.0) disturb += 2.0;
            // 尾段稳定 7
            disturb += 7.0 * clampd_s(rho_min, 0.0, 1.0);
        }
    }
    ctrl += disturb;
    ctrl = clampd_s(ctrl, 0.0, 25.0 + 25.0); // 允许扰动并入

    y.outflow_l = q.outflow_volume_l[2];
    y.efficiency = (q.feed_volume_l > 1e-9) ? clampd_s(y.outflow_l / q.feed_volume_l, 0.0, 2.0) : 0.0;
    // 液位系统不计收益
    const double ben = 0.0;
    double deduction = 0.0;
    for (int pv = 0; pv < 3; ++pv) deduction += safety_deduction_one_tank(s, pv);
    y.cat = make_category(op, target, ctrl, ben, clampd_s(deduction, 0.0, 20.0));
}

static void update_reports(const TankSystem* s) {
    update_tank_reports(s);
    update_system_report(s);
}

void ScoreTick(const TankSystem* s, double dt) {
    if (!s || g_score.mode == SCORE_OFF) return;
    if (dt <= 0.0) dt = 1.0;
    // 评分时间：从「开始评分」起实时累加（含尚未点「启动」的搭线时间），暂停也照走
    if (g_score.session_active) g_score.session_t += dt;
    // 限时到点：自动结束本轮评分，成绩封存（结束时间只在评分结果画面显示）
    if (g_score.session_active && g_score.session_t >= ScoreSessionDuration()) {
        g_score.session_t = ScoreSessionDuration();
        g_score.session_active = false;
        g_score.session_finished = true;
        g_score.session_just_end = true;
        update_reports(s);
        return;
    }
    // 未点「开始评分」时只走时钟、不计分；点过之后才按运行状态累计评分
    if (!g_score.session_active) return;
    if (!s->running || s->paused) return;

    ScoreState& q = g_score;
    q.run_begin = true;
    q.run_t += dt;

    const bool pump_on = (s->pump >= 1.0) || (s->pump_cmd >= 1.0);
    bool valve_on = false;
    for (int v = 0; v < N_MV; ++v) {
        if (ValveVal(s, v) > 0.1 || *ValveCmdP(const_cast<TankSystem*>(s), v) > 0.1) {
            valve_on = true;
            break;
        }
    }
    if (!q.start_latch && q.run_t <= 60.0 && s->pump_cmd >= 50.0 && (pump_on || valve_on)) {
        q.start_latch = true;
        q.start_t = q.run_t;
    }

    for (int pv = 0; pv < 3; ++pv) {
        const bool built = tank_has_control(s, pv);
        const bool autoctl = tank_all_auto(s, pv);
        if (built && q.run_t <= 300.0) q.built_latch[pv] = true;
        if (autoctl && q.run_t <= 300.0) { if (!q.auto_latch[pv]) q.auto_time[pv] = q.run_t; q.auto_latch[pv] = true; }
    }

    if (pump_on) q.control_active = true;
    if (!q.control_active) {
        update_reports(s);
        return;
    }

    q.active_t += dt;
    for (int pv = 0; pv < 3; ++pv) {
        const double pv_pct = level_pct(s, pv);
        const double e = std::fabs(level_sp(s, pv) - pv_pct);
        push_error(pv, e);
        if (pv_pct > q.max_level[pv]) q.max_level[pv] = pv_pct;

        if (tank_has_control(s, pv) && tank_all_auto(s, pv) && e <= g_score.band_tank_pct) {
            q.settle_hold[pv] += dt;
            if (!q.settle_latch[pv] && q.settle_hold[pv] >= 20.0) {
                q.settle_latch[pv] = true;
                q.settle_time[pv] = q.run_t - 20.0 + dt;
            }
        } else {
            q.settle_hold[pv] = 0.0;
        }

        const double tv = true_level_pct(s, pv);
        // 投运判定：冷态起步时三罐均为空，属“建立液位”过程，不参与安全评判；
        // 液位首次进入正常区间(>=7%FS)后该罐才算投运，此后抵限才扣分。
        if (!q.armed[pv] && tv >= 7.0) q.armed[pv] = true;
        if (q.armed[pv]) {
            if (!q.low_active[pv] && tv <= 5.0) q.low_active[pv] = true;
            if (q.low_active[pv] && tv >= 7.0) q.low_active[pv] = false;
            if (q.low_active[pv]) q.low_time[pv] += dt;

            if (!q.high_active[pv] && tv >= 90.0) q.high_active[pv] = true;
            if (q.high_active[pv] && tv <= 88.0) q.high_active[pv] = false;
            if (q.high_active[pv]) q.high_time[pv] += dt;

            if (!q.overflow_latch[pv] && tv >= 99.999) {
                q.overflow_latch[pv] = true;
                q.overflow_events[pv]++;
            }
            if (q.overflow_latch[pv] && tv <= 99.0) q.overflow_latch[pv] = false;

            if (!q.dry_latch[pv] && tv <= 0.001) {
                q.dry_latch[pv] = true;
                q.dry_events[pv]++;
            }
            if (q.dry_latch[pv] && tv >= 1.0) q.dry_latch[pv] = false;
        }
    }

    const double q12 = s->q12;
    const double q23 = s->q23;
    const double qout = s->qout;
    const double qin = s->qin;
    const double vol_scale = dt / 60.0;
    q.inflow_volume_l[0] += qin * vol_scale;
    q.inflow_volume_l[1] += q12 * vol_scale;
    q.inflow_volume_l[2] += q23 * vol_scale;
    q.outflow_volume_l[0] += q12 * vol_scale;
    q.outflow_volume_l[1] += q23 * vol_scale;
    q.outflow_volume_l[2] += qout * vol_scale;
    q.feed_volume_l += qin * vol_scale;

    for (int pv = 0; pv < 3; ++pv) {
        const double sp = level_sp(s, pv);
        const double q_ref = TorricelliQ(sp / 100.0 * TANK_H_MM * MM2M) * M3S2LMIN;
        const double valve_pct = (pv == 0) ? s->valve_12 : (pv == 1 ? s->valve_23 : s->valve_out);
        q.ref_outflow_volume_l[pv] += q_ref * clampd_s(valve_pct, 0.0, 100.0) / 100.0 * vol_scale;
    }

    const double eq = (std::fabs(qin - q12) + std::fabs(q12 - q23) + std::fabs(q23 - qout)) / 3.0;
    q.flow_balance_sum += eq;
    q.flow_balance_n++;

    for (int c = 0; c < s->nCasc; ++c) {
        const CascCfg& C = s->casc[c];
        if (!C.enabled || C.opid.manual || C.ipid.manual) continue;
        double e_pct = 0.0;
        if (PvxIsFlow(C.inner))
            e_pct = std::fabs(C.ipid.last_sp - C.ipid.last_pv) / Q_PUMP_MAX_LMIN * 100.0;
        else
            e_pct = std::fabs(C.ipid.last_e);
        q.inner_err_sum_pct += clampd_s(e_pct, 0.0, 200.0);
        q.inner_err_n++;
    }

    update_reports(s);
}
