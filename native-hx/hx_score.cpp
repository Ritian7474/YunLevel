#include "hx_score.h"

#include <algorithm>
#include <cmath>

// 限时/带宽：教师 SCORE_CFG 可配
double HX_SCORE_DURATION_S = 480.0;
double HX_SCORE_DURATION_SYS = 1500.0;
double HX_BAND_TAIL_RATIO = 0.35;
double HX_TARGET_BAND_C = 5.0;

HxScoreState g_hxScore;

double HxScoreSessionDuration() {
    return g_hxScore.mode == HX_SCORE_SYSTEM ? HX_SCORE_DURATION_SYS : HX_SCORE_DURATION_S;
}

void HxScoreSetConfig(double dur_unit, double dur_sys, double band_hx) {
    if (dur_unit > 1.0) HX_SCORE_DURATION_S = dur_unit;
    if (dur_sys > 1.0) HX_SCORE_DURATION_SYS = dur_sys;
    if (band_hx > 0.01) HX_TARGET_BAND_C = band_hx;
}

namespace {

// 理想燃料单耗 (kg 燃料 / kg 蒸汽)：把 250℃ 饱和汽加热到 480℃ 需要的热量比上
// 燃料的低位热值。实际单耗越接近它，经济性越好。
constexpr double HX_FUEL_PER_STEAM_IDEAL =
    (HX_CP_STEAM * (HX_T_REF - HX_T_SAT)) / (HX_LHV_FUEL * HX_COMBUSTION_EFF);
// 控制评分带宽：出口温度平均绝对偏差 20℃ 记为 0 分。
constexpr double HX_MAE_BAND_C = 20.0;
constexpr double HX_SETTLE_BAND_C = 2.0;
constexpr double HX_OVER_TEMP_C = 560.0;      // 高温报警线
constexpr double HX_UNDER_TEMP_C = 320.0;     // 蒸汽过冷线
constexpr double HX_ARM_TEMP_C = 380.0;       // 投运判定
constexpr int    HX_ERR_WINDOW = 300;

double clampd_s(double v, double lo, double hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

bool hx_has_control(const HxSystem* s) {
    if (!s) return false;
    for (int i = 0; i < s->nLoop; ++i) {
        if (s->loop[i].enabled && s->loop[i].pv == HX_PV_TI1104) return true;
    }
    for (int c = 0; c < s->nCasc; ++c) {
        if (s->casc[c].enabled && s->casc[c].outer == HX_PVX_TI1104) return true;
    }
    return false;
}

bool hx_all_auto(const HxSystem* s) {
    if (!s) return false;
    int n = 0;
    for (int i = 0; i < s->nLoop; ++i) {
        if (!s->loop[i].enabled) continue;
        n++;
        if (s->loop[i].pid.manual) return false;
    }
    for (int c = 0; c < s->nCasc; ++c) {
        if (!s->casc[c].enabled) continue;
        n++;
        if (s->casc[c].opid.manual || s->casc[c].ipid.manual) return false;
    }
    return n > 0;
}

bool hx_has_cascade(const HxSystem* s) {
    if (!s) return false;
    for (int c = 0; c < s->nCasc; ++c) {
        if (s->casc[c].enabled) return true;
    }
    return false;
}

void push_sample(double e, double temp) {
    HxScoreState& q = g_hxScore;
    q.err_win[q.err_head] = e;
    q.temp_win[q.err_head] = temp;
    q.err_head = (q.err_head + 1) % HX_ERR_WINDOW;
    if (q.err_count < HX_ERR_WINDOW) q.err_count++;
}

double window_mae_c() {
    const HxScoreState& q = g_hxScore;
    if (q.err_count <= 0) return 0.0;
    double sum = 0.0;
    for (int i = 0; i < q.err_count; ++i) sum += q.err_win[i];
    return sum / q.err_count;
}

double window_ripple_c() {
    const HxScoreState& q = g_hxScore;
    if (q.err_count <= 0) return 0.0;
    double lo = q.temp_win[0], hi = q.temp_win[0];
    for (int i = 1; i < q.err_count; ++i) {
        if (q.temp_win[i] < lo) lo = q.temp_win[i];
        if (q.temp_win[i] > hi) hi = q.temp_win[i];
    }
    return hi - lo;
}

double settle_score(double t, double full) {
    if (t < 0.0) return 0.0;
    if (t <= 180.0) return full;
    if (t <= 300.0) return full * 0.80;
    if (t <= 600.0) return full * 0.5333333333;
    if (t <= 900.0) return full * 0.20;
    return 0.0;
}

// 超调用温度标度（液位版用 %FS）。
double overshoot_score(double os_c, double full) {
    if (os_c <= 2.0) return full;
    if (os_c <= 5.0) return full * 0.80;
    if (os_c <= 10.0) return full * 0.50;
    if (os_c <= 20.0) return full * 0.20;
    return 0.0;
}

HxScoreCategory make_category(double op, double target, double ctrl, double ben, double deduction) {
    HxScoreCategory c;
    c.operation = clampd_s(op, 0.0, 20.0);
    c.target = clampd_s(target, 0.0, 50.0);
    c.control = clampd_s(ctrl, 0.0, 40.0);
    c.safety = 0.0;
    c.benefit = clampd_s(ben, 0.0, 30.0);
    c.safety_deduction = clampd_s(deduction, 0.0, 20.0);
    c.total = clampd_s(c.operation + c.target + c.control + c.benefit - c.safety_deduction, 0.0, 100.0);
    return c;
}

void reset_run_data(bool begin) {
    HxScoreState& q = g_hxScore;
    q.run_begin = begin;
    q.control_active = false;
    q.run_t = 0.0;
    q.active_t = 0.0;
    q.start_t = 0.0;
    q.start_latch = false;
    q.built_latch = false;
    q.auto_latch = false;
    q.settle_latch = false;
    q.settle_time = -1.0;
    q.settle_hold = 0.0;
    q.max_temp = 0.0;
    q.err_head = 0;
    q.err_count = 0;
    for (int i = 0; i < HX_ERR_WINDOW; ++i) { q.err_win[i] = 0.0; q.temp_win[i] = 0.0; }
    q.armed = false;
    q.reached_sp = false;
    q.over_active = false;
    q.under_active = false;
    q.over_time = 0.0;
    q.under_time = 0.0;
    q.over_latch = false;
    q.steam_sat_time = 0.0;
    q.water_cut_time = 0.0;
    q.over_events = 0;
    q.fuel_used_kg = 0.0;
    q.steam_produced_kg = 0.0;
    q.water_used_kg = 0.0;
    q.inner_err_sum_pct = 0.0;
    q.inner_err_n = 0;
    q.unit_score = HxUnitScore{};
}

void update_report(const HxSystem* s) {
    HxScoreState& q = g_hxScore;
    HxUnitScore& u = q.unit_score;
    const double sp = s ? s->setpoint : 0.0;
    u.loop_built = hx_has_control(s);
    u.loop_auto = hx_all_auto(s);
    u.mae_c = window_mae_c();
    u.settled = q.settle_latch;
    u.settle_s = q.settle_latch ? q.settle_time : -1.0;
    const double os = q.max_temp - sp;
    u.overshoot_c = os > 0.0 ? os : 0.0;
    u.over_time_s = q.over_time;
    u.under_time_s = q.under_time;
    u.steam_sat_s = q.steam_sat_time;
    u.water_cut_s = q.water_cut_time;
    u.ripple_c = window_ripple_c();
    u.fuel_kg = q.fuel_used_kg;
    u.steam_kg = q.steam_produced_kg;
    // 产出率：实际累计产汽量比上设计产汽量（21 kg/s）。
    const double active_s = (q.active_t > 1e-9) ? q.active_t : 0.0;
    const double production = (active_s > 1e-9)
        ? clampd_s(q.steam_produced_kg / (21.0 * active_s), 0.0, 1.0)
        : 0.0;
    const double water_avg = (active_s > 1e-9) ? q.water_used_kg / active_s : 0.0;
    u.efficiency = production;

    // 操作 20：起步3 + 建立5 + 投自动7 + 稳态5（分步给分）
    double op = q.start_latch ? 3.0 : 0.0;
    op += q.built_latch ? 5.0 : 0.0;
    if (q.auto_latch) op += 7.0;
    if (q.settle_latch && q.settle_time <= 600.0) op += 5.0;

    // 尾段目标/控制 50 = ρ_tail×30 + MAE12 + 超调8
    const double tail_w = HX_BAND_TAIL_RATIO * HxScoreSessionDuration();
    double band_t = 0.0;
    for (int i = 0; i < q.err_count; ++i) {
        const int idx = (q.err_head - 1 - i + HX_ERR_WINDOW * 2) % HX_ERR_WINDOW;
        if (q.err_win[idx] <= HX_TARGET_BAND_C) band_t += 1.0; // 每拍约 1s
    }
    // 近似：用最近 300 拍中在带比例 × 窗（当会话够长）
    const double rho = (q.err_count > 0) ? clampd_s(band_t / q.err_count, 0.0, 1.0) : 0.0;
    const double target = 30.0 * rho;
    double ctrl = 0.0;
    if (q.built_latch && q.auto_latch) {
        ctrl += 12.0 * clampd_s(1.0 - u.mae_c / HX_MAE_BAND_C, 0.0, 1.0);
        ctrl += 8.0 * clampd_s(1.0 - u.overshoot_c / 20.0, 0.0, 1.0);
    }

    // 安全倒扣（v2）
    const double d_over = clampd_s(3.0 * std::floor(q.over_time / 60.0), 0.0, 6.0);
    const double d_under = clampd_s(3.0 * std::floor(q.under_time / 60.0), 0.0, 6.0);
    const double d_sat = clampd_s(2.0 * std::floor(q.steam_sat_time / 60.0), 0.0, 6.0);
    const double d_cut = clampd_s(3.0 * std::floor(q.water_cut_time / 60.0), 0.0, 6.0);
    const double deduction = clampd_s(d_over + d_under + d_sat + d_cut, 0.0, 20.0);

    // 收益 30：产汽 12 + 燃料效率 12 + 平稳 6（本期系统不考扰动）
    double ben = 0.0;
    if (q.control_active) {
        const double water_avg2 = (active_s > 1e-9) ? q.water_used_kg / active_s : 0.0;
        const double steam_out = clampd_s(production, 0.0, 1.0);
        const double fuel_eff = clampd_s((u.fuel_kg > 1e-9) ? (u.steam_kg / std::max(u.fuel_kg, 1e-6)) / 12.0 : 0.0, 0.0, 1.0);
        const double smooth = clampd_s(1.0 - u.ripple_c / 15.0, 0.0, 1.0);
        ben = 12.0 * steam_out + 12.0 * fuel_eff + 6.0 * smooth;
        (void)water_avg2;
    }

    u.cat = make_category(op, target, ctrl, ben, deduction);
}

}  // namespace

void HxScoreInit() {
    g_hxScore = HxScoreState{};
    g_hxScore.mode = HX_SCORE_OFF;
    g_hxScore.settle_time = -1.0;
    g_hxScore.unit = 0;
}

void HxScoreColdReset() {
    const HxScoreMode mode = g_hxScore.mode;
    const int unit = g_hxScore.unit;
    const double session_t = g_hxScore.session_t;
    const bool active = g_hxScore.session_active;
    HxScoreInit();
    g_hxScore.mode = mode;
    g_hxScore.unit = unit;
    g_hxScore.session_t = session_t;
    g_hxScore.session_active = active;
}

void HxScoreBeginSession() {
    const HxScoreMode mode = g_hxScore.mode;
    const int unit = g_hxScore.unit;
    reset_run_data(true);
    g_hxScore.mode = mode;
    g_hxScore.unit = unit;
    g_hxScore.session_active = true;
    g_hxScore.session_finished = false;
    g_hxScore.session_just_end = false;
    g_hxScore.session_t = 0.0;
}

void HxScoreEndSession() {
    g_hxScore.session_active = false;
    g_hxScore.session_finished = false;
    g_hxScore.session_just_end = false;
    g_hxScore.session_t = 0.0;
    reset_run_data(false);
}

bool HxScoreSessionActive() { return g_hxScore.session_active; }
void HxScoreFinishSession() {
    if (!g_hxScore.session_active) return;
    g_hxScore.session_active = false;
    g_hxScore.session_finished = true;
    g_hxScore.session_just_end = true;
    g_hxScore.unit_score.cat = {};
}
bool HxScoreSessionFinished() { return g_hxScore.session_finished; }

bool HxScoreTakeFinishedEvent() {
    if (!g_hxScore.session_just_end) return false;
    g_hxScore.session_just_end = false;
    return true;
}

void HxScoreBeginRun(const HxSystem* s) {
    (void)s;
    reset_run_data(g_hxScore.mode != HX_SCORE_OFF);
}

void HxScoreSetMode(HxScoreMode mode) {
    if (mode < HX_SCORE_OFF || mode > HX_SCORE_SYSTEM) mode = HX_SCORE_OFF;
    if (g_hxScore.mode == mode) return;
    g_hxScore.mode = mode;
    reset_run_data(false);
}

void HxScoreTick(const HxSystem* s, double dt) {
    if (!s || g_hxScore.mode == HX_SCORE_OFF) return;
    if (dt <= 0.0) dt = 1.0;
    HxScoreState& q = g_hxScore;

    // 评分时间：从「开始评分」起实时累加，含尚未点「启动」的搭线时间，暂停也照走。
    if (q.session_active) q.session_t += dt;
    if (q.session_active && q.session_t >= HxScoreSessionDuration()) {
        q.session_t = HxScoreSessionDuration();
        q.session_active = false;
        q.session_finished = true;
        q.session_just_end = true;
        update_report(s);
        return;
    }
    if (!q.session_active) return;
    if (!s->running || s->paused) return;

    q.run_begin = true;
    q.run_t += dt;

    const bool valve_on = (s->water_valve_open > 0.1) || (s->fuel_valve_open > 0.1) || (s->fv1105_open > 0.1);
    if (!q.start_latch && q.run_t <= 60.0 && valve_on) {
        q.start_latch = true;
        q.start_t = q.run_t;
    }
    const bool built = hx_has_control(s);
    const bool autoctl = hx_all_auto(s);
    if (built && q.run_t <= 300.0) q.built_latch = true;
    if (autoctl && q.run_t <= 300.0) q.auto_latch = true;
    if (valve_on) q.control_active = true;
    if (!q.control_active) { update_report(s); return; }

    q.active_t += dt;
    q.fuel_used_kg += s->fuel_flow * dt;
    q.steam_produced_kg += s->steam_flow * dt;
    q.water_used_kg += s->mw * dt;

    const double pv = s->T_measured;
    const double sp = s->setpoint;
    const double e = std::fabs(sp - pv);
    // 超调只在「已经到过给定附近」之后统计：COOL_480 冷态起步本身就高于给定，
    // 那是工况初始条件，不算控制器的超调。
    if (built && autoctl && e <= HX_TARGET_BAND_C) q.reached_sp = true;
    push_sample(e, pv);
    if (q.reached_sp && pv > q.max_temp) q.max_temp = pv;

    if (built && autoctl && e <= HX_SETTLE_BAND_C) {
        q.settle_hold += dt;
        if (!q.settle_latch && q.settle_hold >= 20.0) {
            q.settle_latch = true;
            q.settle_time = q.run_t - 20.0 + dt;
        }
    } else {
        q.settle_hold = 0.0;
    }

    // 投运判定：出口温度首次进入正常区间后，该单元才算投运，此后抵限才扣分。
    if (!q.armed && pv >= HX_ARM_TEMP_C) q.armed = true;
    if (q.armed) {
        if (!q.over_active && pv >= HX_OVER_TEMP_C) q.over_active = true;
        if (q.over_active && pv <= HX_OVER_TEMP_C - 20.0) q.over_active = false;
        if (q.over_active) q.over_time += dt;

        if (!q.under_active && pv <= HX_UNDER_TEMP_C) q.under_active = true;
        if (q.under_active && pv >= HX_UNDER_TEMP_C + 30.0) q.under_active = false;
        if (q.under_active) q.under_time += dt;
    }

    // 蒸汽阀饱和：自动状态下阀门长期压在 100%。
    const bool steam_auto = hx_has_control(s) && hx_all_auto(s);
    if (steam_auto && s->fv1105_open_eff >= 99.5) q.steam_sat_time += dt;
    // 冷却水断流：冷却水全关而出口温度仍在高温区。
    if (s->mw <= 0.05 && pv >= 500.0) q.water_cut_time += dt;

    // 超温事件计数（进限一次记一次）。
    if (pv >= HX_OVER_TEMP_C && !q.over_latch) {
        q.over_latch = true;
        q.over_events++;
    }
    if (q.over_latch && pv <= HX_OVER_TEMP_C - 20.0) q.over_latch = false;

    // 串级副环跟踪偏差（按量程百分比）。
    for (int c = 0; c < s->nCasc; ++c) {
        const HxCasc& C = s->casc[c];
        if (!C.enabled || C.ipid.manual) continue;
        const double span = HxPvSpan(C.inner);
        const double pct = (span > 1e-9) ? std::fabs(C.ipid.last_e) / span * 100.0 : 0.0;
        q.inner_err_sum_pct += clampd_s(pct, 0.0, 200.0);
        q.inner_err_n++;
    }

    update_report(s);
}
