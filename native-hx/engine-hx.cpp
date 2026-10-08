// engine-hx.cpp -- stdio engine for the heat exchanger model.
//
// Protocol is byte-for-byte the same shape as native/engine.cpp (one command
// per line on stdin, one JSON object per command on stdout) so the Node
// gateway can drive both kernels without a model branch: it only has to send
// the same command names and read the same message.type values.

#include "hx_model.h"
#include "hx_score.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>

namespace {

constexpr unsigned int STATE_VERSION = 3u;   // v3 adds the score blob (v2 added the cascade tables)

struct StateHeader {
    unsigned int magic;
    unsigned int version;
    unsigned int sys_bytes;
    unsigned int bias;
    unsigned int scenario;
    unsigned int reserved;
};

struct Engine {
    HxSystem sys;
    bool bias = false;
    bool state_dirty = false;
    int  scenario = HX_SCENARIO_COOL_480;
    unsigned long long tick_count = 0;
    std::string state_path;
};

Engine g_engine;

double clampd(double v, double lo, double hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

bool read_all(FILE* fp, void* dst, size_t bytes) {
    return bytes == 0 || std::fread(dst, 1, bytes, fp) == bytes;
}

bool write_all(FILE* fp, const void* src, size_t bytes) {
    return bytes == 0 || std::fwrite(src, 1, bytes, fp) == bytes;
}

// ---------------------------------------------------------------------------
// state.bin -- header + raw HxSystem blob.  A different magic from the tank
// kernel means a cross-model restore can never be accepted by accident.
// ---------------------------------------------------------------------------
void save_state() {
    if (g_engine.state_path.empty()) return;
    const std::string tmp = g_engine.state_path + ".tmp";
    FILE* fp = std::fopen(tmp.c_str(), "wb");
    if (!fp) return;
    StateHeader h{};
    h.magic = HX_STATE_MAGIC;
    h.version = STATE_VERSION;
    h.sys_bytes = (unsigned int)sizeof(HxSystem);
    h.bias = g_engine.bias ? 1u : 0u;
    h.scenario = (unsigned int)g_engine.scenario;
    h.reserved = (unsigned int)sizeof(HxScoreState);
    bool ok = write_all(fp, &h, sizeof(h)) && write_all(fp, &g_engine.sys, sizeof(g_engine.sys))
        && write_all(fp, &g_hxScore, sizeof(g_hxScore));
    if (std::fclose(fp) != 0) ok = false;
    if (!ok) { std::remove(tmp.c_str()); return; }
    std::remove(g_engine.state_path.c_str());
    if (std::rename(tmp.c_str(), g_engine.state_path.c_str()) != 0) std::remove(tmp.c_str());
    else g_engine.state_dirty = false;
}

void load_state() {
    if (g_engine.state_path.empty()) return;
    FILE* fp = std::fopen(g_engine.state_path.c_str(), "rb");
    if (!fp) return;
    StateHeader h{};
    HxSystem saved{};
    HxScoreState savedScore{};
    bool ok = read_all(fp, &h, sizeof(h));
    if (ok && h.magic == HX_STATE_MAGIC && h.version == STATE_VERSION
        && h.sys_bytes == sizeof(HxSystem) && h.reserved == sizeof(HxScoreState)) {
        ok = read_all(fp, &saved, sizeof(saved)) && read_all(fp, &savedScore, sizeof(savedScore));
    } else {
        ok = false;
    }
    std::fclose(fp);
    if (!ok) return;
    g_engine.sys = saved;
    g_hxScore = savedScore;
    g_hxScore.session_just_end = false;
    g_engine.bias = h.bias != 0u;
    g_engine.scenario = (int)h.scenario;
    g_usePidBias = g_engine.bias;
}

// ---------------------------------------------------------------------------
// JSON output helpers
// ---------------------------------------------------------------------------
void json_num(const char* key, double value, bool& first) {
    if (!first) std::fputs(",", stdout);
    first = false;
    std::printf("\"%s\":%.6g", key, value);
}

void json_int(const char* key, long long value, bool& first) {
    if (!first) std::fputs(",", stdout);
    first = false;
    std::printf("\"%s\":%lld", key, value);
}

void json_bool(const char* key, bool value, bool& first) {
    if (!first) std::fputs(",", stdout);
    first = false;
    std::printf("\"%s\":%s", key, value ? "true" : "false");
}

double pid_ti_out(const PID& p) {
    return std::isinf(p.Ti) ? -1.0 : p.Ti;   // -1 means "integral off" on the wire
}

void emit_state(bool score_ended = false) {
    const HxSystem* s = &g_engine.sys;
    std::fputs("{\"type\":\"state\"", stdout);
    bool first = false;

    json_num("sim_time", s->sim_time, first);
    json_bool("running", s->running, first);
    json_bool("paused", s->paused, first);
    json_bool("bias", g_engine.bias, first);
    json_int("scenario", g_engine.scenario, first);
    json_int("mode", s->mode, first);
    json_bool("scoreEnded", score_ended, first);
    json_bool("fuelLocked", s->fuel_temperature_locked, first);

    // measured values / setpoints
    json_num("ti1104", s->T_measured, first);     // TI1104 PV
    json_num("ti1104raw", s->T, first);           // TI1104 true outlet
    json_num("sp", s->setpoint, first);           // TI1104 SP
    json_num("ti1103", s->T_inlet, first);        // TI1103
    json_num("twater", s->T_water_out, first);
    json_num("twall", s->T_wall, first);
    json_num("fi1105", s->steam_flow, first);     // FI1105 PV
    json_num("spf", s->flow_setpoint, first);     // FI1105 SP
    json_num("fi1105sp", s->steam_flow_setpoint, first);

    // actuators
    json_num("fv1102", s->water_valve_open, first);
    json_num("fv1102eff", s->water_valve_open_eff, first);
    json_num("fv1101", s->fuel_valve_open, first);
    json_num("fv1101eff", s->fuel_valve_open_eff, first);
    json_num("fv1105", s->fv1105_open, first);
    json_num("fv1105eff", s->fv1105_open_eff, first);
    json_num("fv1105min", s->fv1105_open_min, first);
    json_num("hv1102", s->hv1102_open, first);
    json_num("relieve", s->relieve_flow, first);
    for (int mv = 0; mv < HX_MV_COUNT; ++mv) {
        char key[24];
        std::snprintf(key, sizeof(key), "vhand%d", mv);
        json_num(key, s->vhand[mv], first);
    }

    // process
    json_num("fuel", s->fuel_flow, first);
    json_num("mw", s->mw, first);
    json_num("level", s->FV1102_level, first);
    json_num("quality", s->steam_quality, first);
    json_num("khx", s->k_hx, first);
    json_num("pressure", s->steam_pressure, first);
    json_num("qin", s->Q_in, first);
    json_num("qout", s->Q_out, first);
    json_num("qloss", s->Q_loss, first);
    json_num("qhx", s->Q_hx, first);
    json_num("qmetal", s->Q_metal, first);
    json_num("qspray", s->Q_spray, first);
    json_num("yaxis", s->y_axis_max, first);

    json_int("nLoop", s->nLoop, first);
    std::fputs(",\"loops\":[", stdout);
    for (int i = 0; i < s->nLoop; ++i) {
        const HxLoop& L = s->loop[i];
        if (i) std::fputc(',', stdout);
        std::fputs("{", stdout);
        bool b = true;
        json_int("pv", L.pv, b);
        json_int("mv", L.mv, b);
        json_bool("enabled", L.enabled, b);
        json_bool("manual", L.pid.manual, b);
        json_int("action", L.pid.action, b);
        json_num("sp", HxPvSetpoint(s, L.pv), b);
        json_num("pvValue", HxPvValue(s, L.pv), b);
        json_num("kp", L.pid.Kp, b);
        json_num("ti", pid_ti_out(L.pid), b);
        json_num("td", L.pid.Td, b);
        json_num("out", L.pid.out, b);
        json_num("manualOut", L.pid.manual_out, b);
        json_num("e", L.pid.last_e, b);
        json_num("pTerm", L.pid.last_p_term, b);
        json_num("iTerm", L.pid.last_i_term, b);
        json_num("dTerm", L.pid.last_d_term, b);
        json_num("uBias", L.pid.last_u_bias, b);
        json_num("uRaw", L.pid.last_u_raw, b);
        std::fputs("}", stdout);
    }
    std::fputs("]", stdout);

    // 串级表：字段与液位内核逐项同名，前端串级卡因此完全复用。
    json_int("nCasc", s->nCasc, first);
    std::fputs(",\"cascades\":[", stdout);
    for (int c = 0; c < s->nCasc; ++c) {
        const HxCasc& C = s->casc[c];
        if (c) std::fputc(',', stdout);
        std::fputs("{", stdout);
        bool b = true;
        json_int("mv", C.mv, b);
        json_int("outer", C.outer, b);
        json_int("inner", C.inner, b);
        json_bool("enabled", C.enabled, b);
        json_bool("outerManual", C.opid.manual, b);
        json_bool("innerManual", C.ipid.manual, b);
        json_int("outerAction", C.opid.action, b);
        json_int("innerAction", C.ipid.action, b);
        json_num("outerSp", HxPvSetpoint(s, C.outer), b);
        json_num("innerSp", HxPvSetpoint(s, C.inner), b);
        json_num("outerKp", C.opid.Kp, b);
        json_num("outerTi", pid_ti_out(C.opid), b);
        json_num("outerTd", C.opid.Td, b);
        json_num("innerKp", C.ipid.Kp, b);
        json_num("innerTi", pid_ti_out(C.ipid), b);
        json_num("innerTd", C.ipid.Td, b);
        json_num("outerOut", C.opid.out, b);
        json_num("innerOut", C.ipid.out, b);
        json_num("outerE", C.opid.last_e, b);
        json_num("outerP", C.opid.last_p_term, b);
        json_num("outerI", C.opid.last_i_term, b);
        json_num("outerD", C.opid.last_d_term, b);
        json_num("innerE", C.ipid.last_e, b);
        json_num("innerP", C.ipid.last_p_term, b);
        json_num("innerI", C.ipid.last_i_term, b);
        json_num("innerD", C.ipid.last_d_term, b);
        json_num("outerPvValue", C.opid.last_pv, b);
        json_num("innerPvValue", C.ipid.last_pv, b);
        std::fputs("}", stdout);
    }
    std::fputs("]", stdout);

    // 评分块：字段与液位内核逐项同名，前端评分页与教师端记录页因此完全复用。
    std::fputs(",\"score\":{", stdout);
    bool sf = true;
    json_int("mode", (int)g_hxScore.mode, sf);
    json_int("tank", g_hxScore.unit, sf);
    json_bool("active", g_hxScore.session_active, sf);
    json_bool("finished", g_hxScore.session_finished, sf);
    json_num("sessionT", g_hxScore.session_t, sf);
    json_num("runT", g_hxScore.run_t, sf);
    json_num("activeT", g_hxScore.active_t, sf);
    json_num("durationS", HxScoreSessionDuration(), sf);
    json_num("total", g_hxScore.unit_score.cat.total, sf);
    json_num("operation", g_hxScore.unit_score.cat.operation, sf);
    json_num("control", g_hxScore.unit_score.cat.control, sf);
    json_num("safety", g_hxScore.unit_score.cat.safety, sf);
    json_num("benefit", g_hxScore.unit_score.cat.benefit, sf);
    json_num("target", g_hxScore.unit_score.cat.target, sf);
    json_num("safetyDeduction", g_hxScore.unit_score.cat.safety_deduction, sf);
    json_num("innerMae", (g_hxScore.inner_err_n > 0) ? g_hxScore.inner_err_sum_pct / g_hxScore.inner_err_n : 0.0, sf);
    json_num("fuel", g_hxScore.unit_score.fuel_kg, sf);
    json_num("steam", g_hxScore.unit_score.steam_kg, sf);
    json_num("efficiency", g_hxScore.unit_score.efficiency, sf);
    std::fputs("},\"tanks\":[", stdout);
    {
        const HxUnitScore& u = g_hxScore.unit_score;
        std::fputs("{", stdout);
        bool b = true;
        json_num("total", u.cat.total, b);
        json_num("operation", u.cat.operation, b);
        json_num("control", u.cat.control, b);
        json_num("safety", u.cat.safety, b);
        json_num("benefit", u.cat.benefit, b);
        json_bool("built", u.loop_built, b);
        json_bool("auto", u.loop_auto, b);
        json_bool("settled", u.settled, b);
        json_num("mae", u.mae_c, b);
        json_num("settle", u.settle_s, b);
        json_num("overshoot", u.overshoot_c, b);
        json_num("lowTime", u.under_time_s, b);
        json_num("highTime", u.over_time_s, b);
        json_int("overflow", 0, b);
        json_int("dry", g_hxScore.over_events, b);
        json_num("outflow", u.steam_kg, b);
        json_num("efficiency", u.efficiency, b);
        json_num("ripple", u.ripple_c, b);
        json_num("satTime", u.steam_sat_s, b);
        json_num("cutTime", u.water_cut_s, b);
        std::fputs("}", stdout);
    }
    std::fputs("]", stdout);

    std::fputs("}\n", stdout);
    std::fflush(stdout);
}

void emit_error(const char* code, const std::string& message) {
    std::printf("{\"type\":\"error\",\"code\":\"%s\",\"message\":\"%s\"}\n", code, message.c_str());
    std::fflush(stdout);
}

const char* mv_label(int mv) {
    switch (mv) {
        case HX_MV_FV1102: return "FV1102";
        case HX_MV_FV1101: return "FV1101";
        case HX_MV_FV1105: return "FV1105";
        case HX_MV_HV1102: return "HV1102";
        default: return "?";
    }
}

void reset_to_cold() {
    // 与液位同规则：回到冷态只把物理状态推回工况初值，
    // 已经搭好的回路/串级/方案与给定值全部保留。
    HxSystem* s = &g_engine.sys;
    const int mode = s->mode;
    const double setpoint = s->setpoint;
    const double flow_sp = s->flow_setpoint;
    const double fv1105_min = s->fv1105_open_min;
    const double ymax = s->y_axis_max;

    HxLoop loopBak[HX_MAX_LOOPS];
    const int nLoop = s->nLoop;
    for (int i = 0; i < nLoop; ++i) loopBak[i] = s->loop[i];
    HxCasc cascBak[HX_MAX_CASC];
    const int nCasc = s->nCasc;
    for (int i = 0; i < nCasc; ++i) cascBak[i] = s->casc[i];

    HxInitScenario(s, g_engine.scenario);

    s->mode = mode;
    for (int i = 0; i < nLoop; ++i) s->loop[i] = loopBak[i];
    s->nLoop = nLoop;
    for (int i = 0; i < nCasc; ++i) s->casc[i] = cascBak[i];
    s->nCasc = nCasc;
    s->setpoint = setpoint;
    s->flow_setpoint = flow_sp;
    s->fv1105_open_min = fv1105_min;
    s->y_axis_max = ymax;
    g_usePidBias = g_engine.bias;
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------
void process_line(const std::string& line) {
    std::istringstream iss(line);
    std::string cmd;
    if (!(iss >> cmd)) return;
    HxSystem* s = &g_engine.sys;
    bool state_changed = false;
    bool score_ended = false;

    if (cmd == "STATE") {
        // no-op
    } else if (cmd == "TICK") {
        int run = 0;
        iss >> run;
        if (run && !s->paused) {
            s->running = true;
            HxStep(s, 1.0);
        }
        HxScoreTick(s, 1.0);
        score_ended = HxScoreTakeFinishedEvent();
        g_engine.tick_count++;
        if (g_engine.tick_count % 30ull == 0ull) save_state();
    } else if (cmd == "START") {
        s->running = true;
        s->paused = false;
        HxScoreBeginRun(s);
        state_changed = true;
    } else if (cmd == "PAUSE") {
        s->paused = !s->paused;
        state_changed = true;
    } else if (cmd == "DEACTIVATE") {
        s->running = false;
        s->paused = true;
        state_changed = true;
    } else if (cmd == "RESET") {
        reset_to_cold();
        HxScoreColdReset();
        state_changed = true;
    } else if (cmd == "SCENARIO") {
        int sc = 0;
        iss >> sc;
        if (sc != HX_SCENARIO_COOL_480 && sc != HX_SCENARIO_HEAT_100) {
            emit_error("SCENARIO_INVALID", "工况编号无效");
            return;
        }
        if (s->running) {
            emit_error("SCENARIO_RUNNING", "运行中不能切换工况");
            return;
        }
        g_engine.scenario = sc;
        reset_to_cold();
        state_changed = true;
    } else if (cmd == "SET_BIAS") {
        int v = 0;
        iss >> v;
        g_engine.bias = v != 0;
        g_usePidBias = g_engine.bias;
        state_changed = true;
    } else if (cmd == "SET_MODE") {
        int mode = 0;
        iss >> mode;
        if (mode != HX_MODE_LOOP && mode != HX_MODE_CASC) {
            emit_error("MODE_INVALID", "控制方案无效");
            return;
        }
        if (s->running) {
            emit_error("MODE_RUNNING", "运行中不能切换单回路/串级方案");
            return;
        }
        if (mode != s->mode && !HxSetMode(s, mode)) {
            emit_error("MODE_INVALID", "控制方案无效");
            return;
        }
        state_changed = true;
    } else if (cmd == "SET_SP") {
        // 两种写法都收：`SET_SP <值>`（老写法，给 TI1104）与
        // `SET_SP <pv> <值>`（与液位内核同形，单回路卡片用这一种）。
        std::string t1, t2;
        if (iss >> t1) {
            if (iss >> t2) {
                const int pv = std::atoi(t1.c_str());
                if (pv < 0 || pv >= HX_PVX_COUNT) {
                    emit_error("SET_SP_INVALID", "被控量编号无效");
                    return;
                }
                HxWritePvSetpoint(s, pv, std::atof(t2.c_str()));
            } else {
                HxWritePvSetpoint(s, HX_PVX_TI1104, std::atof(t1.c_str()));
            }
        }
        state_changed = true;
    } else if (cmd == "SET_FLOW_SP") {
        // `SET_FLOW_SP <值>` 与 `SET_FLOW_SP <idx> <值>` 都收到 FI1105。
        std::string f1, f2;
        if (iss >> f1) {
            const std::string value = (iss >> f2) ? f2 : f1;
            HxWritePvSetpoint(s, HX_PVX_FI1105, std::atof(value.c_str()));
        }
        state_changed = true;
    } else if (cmd == "SET_PVX_SP") {
        // 串级卡改主环给定：sel 就是本模型的 PV 下标（0=TI1104 / 1=FI1105）。
        int sel = 0;
        double v = 0.0;
        iss >> sel >> v;
        if (sel < 0 || sel >= HX_PVX_COUNT) {
            emit_error("SET_SP_INVALID", "被控量编号无效");
            return;
        }
        HxWritePvSetpoint(s, sel, v);
        state_changed = true;
    } else if (cmd == "SET_FUEL") {
        double v = 0.0;
        iss >> v;
        if (!s->fuel_temperature_locked && HxValveOccupied(s, HX_MV_FV1101)) {
            emit_error("VALVE_LOOP_OCCUPIED", "FV1101 已由控制回路驱动，请先在回路卡中处理");
            return;
        }
        s->fuel_valve_open = clampd(v, 0.0, 100.0);
        s->fuel_valve_open_eff = s->fuel_valve_open;
        s->vhand[HX_MV_FV1101] = s->fuel_valve_open;
        s->fuel_flow = HxValveToFuel(s->fuel_valve_open);
        s->fuel_temperature_locked = false;   // fuel now drives TI1103
        state_changed = true;
    } else if (cmd == "SET_VALVE") {
        int mv = 0;
        double v = 0.0;
        iss >> mv >> v;
        if (mv < 0 || mv >= HX_MV_COUNT) {
            emit_error("LOOP_INVALID_SELECTION", "阀门编号无效");
            return;
        }
        if (HxValveOccupied(s, mv)) {
            emit_error("VALVE_LOOP_OCCUPIED", std::string(mv_label(mv)) + " 已由控制回路驱动，请先在回路卡中处理");
            return;
        }
        s->vhand[mv] = clampd(v, 0.0, 100.0);
        if (mv == HX_MV_FV1102) s->water_valve_open = s->vhand[mv];
        else if (mv == HX_MV_FV1105) s->fv1105_open = s->vhand[mv];
        else if (mv == HX_MV_HV1102) { s->hv1102_open = s->vhand[mv]; s->hv1102_open_eff = s->vhand[mv]; }
        else if (mv == HX_MV_FV1101) {
            s->fuel_valve_open = s->vhand[mv];
            s->fuel_flow = HxValveToFuel(s->fuel_valve_open);
            s->fuel_temperature_locked = false;
        }
        state_changed = true;
    } else if (cmd == "SET_FV1105_MIN") {
        double v = 0.0;
        iss >> v;
        s->fv1105_open_min = clampd(v, 0.0, 100.0);
        if (s->fv1105_open_eff < s->fv1105_open_min) s->fv1105_open_eff = s->fv1105_open_min;
        state_changed = true;
    } else if (cmd == "SET_YAXIS") {
        double v = 0.0;
        iss >> v;
        s->y_axis_max = clampd(v, 0.0, 2000.0);
        state_changed = true;
    } else if (cmd == "LOOP_ADD") {
        int pv = 0, mv = 0;
        iss >> pv >> mv;
        if (pv < 0 || pv >= HX_PV_COUNT || mv < 0 || mv >= HX_MV_COUNT) {
            emit_error("LOOP_INVALID_SELECTION", "被控量或阀门编号无效");
            return;
        }
        const int result = HxLoopAdd(s, pv, mv);
        if (result < 0) {
            if (result == HX_LOOP_ADD_DUPLICATE) {
                emit_error("LOOP_DUPLICATE", "该位号与阀门的回路已经存在");
            } else if (result == HX_LOOP_ADD_MV_CONFLICT) {
                emit_error("LOOP_MV_CONFLICT", std::string(mv_label(mv)) + " 已被其他回路占用，请换阀门或先删除原回路");
            } else {
                emit_error("LOOP_FULL", "回路数量已达上限，最多允许 4 条");
            }
            return;
        }
        state_changed = true;
    } else if (cmd == "LOOP_DEL") {
        int idx = 0;
        iss >> idx;
        if (!HxLoopDel(s, idx)) {
            emit_error("LOOP_TARGET_INVALID", "回路不存在");
            return;
        }
        state_changed = true;
    } else if (cmd == "LOOP_CLEAR") {
        HxLoopClear(s);
        state_changed = true;
    } else if (cmd == "CASC_ADD") {
        int mv = 0, outer = 0, inner = 0;
        iss >> mv >> outer >> inner;
        if (s->mode != HX_MODE_CASC) {
            emit_error("CASC_MODE_REQUIRED", "请先切换到串级方案");
            return;
        }
        if (mv < 0 || mv >= HX_MV_COUNT || outer < 0 || outer >= HX_PVX_COUNT || inner < 0 || inner >= HX_PVX_COUNT) {
            emit_error("CASC_INVALID_SELECTION", "主环、副环或阀门编号无效");
            return;
        }
        const int cascResult = HxCascAdd(s, mv, outer, inner);
        if (cascResult < 0) {
            if (cascResult == HX_CASC_ADD_DUPLICATE) {
                emit_error("CASC_DUPLICATE", "该阀门与主副环组合已经存在");
            } else if (cascResult == HX_CASC_ADD_MV_CONFLICT) {
                emit_error("CASC_MV_CONFLICT", std::string(mv_label(mv)) + " 已被其他回路占用，请换阀门或先删除原回路");
            } else {
                emit_error("CASC_FULL", "回路数量已达上限，串级与单回路合计最多 4 条");
            }
            return;
        }
        state_changed = true;
    } else if (cmd == "CASC_DEL") {
        int idx = 0;
        iss >> idx;
        if (!HxCascDel(s, idx)) {
            emit_error("CASC_TARGET_INVALID", "串级回路不存在");
            return;
        }
        state_changed = true;
    } else if (cmd == "CASC_CLEAR") {
        HxCascClear(s);
        state_changed = true;
    } else if (cmd == "PRESET") {
        // 推荐模板是单回路 TI1104->FV1102，配 COOL_480 工况：入口就是 480℃，
        // 冷却水阀有完整的调节行程，单回路能稳稳停在中间温度。
        if (s->running) {
            emit_error("TEMPLATE_RUNNING", "运行中不能套用模板，请先回到冷态");
            return;
        }
        g_engine.scenario = HX_SCENARIO_COOL_480;
        reset_to_cold();
        HxApplyRecommendedTemplate(s);
        state_changed = true;
    } else if (cmd == "HIGH_SCORE") {
        if (s->running) {
            emit_error("TEMPLATE_RUNNING", "运行中不能套用模板，请先回到冷态");
            return;
        }
        // 单回路方案在 COOL_480 下整定；串级要 HEAT_100 才有副环->主环耦合。
        g_engine.scenario = (s->mode == HX_MODE_CASC) ? HX_SCENARIO_HEAT_100 : HX_SCENARIO_COOL_480;
        reset_to_cold();
        HxApplyHighScoreTemplate(s);
        state_changed = true;
    } else if (cmd == "SET_PID") {
        std::string kind;
        int idx = 0, action = 1, manual = 0;
        double kp = 1.0, ti = -1.0, td = 0.0, manualOut = 0.0;
        iss >> kind >> idx >> kp >> ti >> td >> action >> manual >> manualOut;
        if (std::isnan(ti) || ti == 0.0) {
            emit_error("PID_TI_INVALID", "Ti 不能为 0；关闭积分请填 inf");
            return;
        }
        // 目标选择：单回路 / 串级主环 / 串级副环，与液位内核同一套 kind 词表。
        PID* target = nullptr;
        if (kind == "outer" || kind == "inner") {
            if (idx >= 0 && idx < s->nCasc) {
                target = (kind == "outer") ? &s->casc[idx].opid : &s->casc[idx].ipid;
            }
        } else {
            int loopIndex = -1;
            if (kind == "loop" || kind == "temp") {
                loopIndex = (idx >= 0 && idx < s->nLoop) ? idx : -1;
            } else if (kind == "flow") {
                loopIndex = HxLoopByPv(s, HX_PV_FI1105);
            } else if (kind == "pv") {
                loopIndex = HxLoopByPv(s, idx);
            }
            if (loopIndex >= 0) target = &s->loop[loopIndex].pid;
        }
        if (!target) {
            emit_error("PID_TARGET_INVALID", "PID 目标回路不存在");
            return;
        }
        target->Kp = clampd(kp, 0.0, 1000.0);
        if (ti < 0.0 || std::isinf(ti)) target->Ti = PID_TI_OFF;
        else target->Ti = clampd(ti, 1.0e-9, 1.0e9);
        target->Td = clampd(td, 0.0, 1.0e6);
        target->action = (action < 0) ? -1 : 1;
        target->manual = manual != 0;
        target->manual_out = clampd(manualOut, target->out_min, target->out_max);
        if (target->manual) PidReset(target, target->manual_out);
        state_changed = true;
    } else if (cmd == "SET_INIT_TEMP") {
        double t = 400.0;
        iss >> t;
        if (!s->running) {
            HxSetInitTemp(s, t);
            state_changed = true;
        } else {
            emit_error("INIT_TEMP_RUNNING", "请先回到冷态，再改初始温度");
            return;
        }
    } else if (cmd == "SET_INLET_TEMP") {
        double t = 400.0;
        iss >> t;
        if (!(t >= 250.0 && t <= 650.0)) {
            emit_error("INLET_TEMP_RANGE", "TI1103 入口温度需在 250～650 ℃");
            return;
        }
        HxSetInletTemp(s, t);
        state_changed = true;
    } else if (cmd == "SCORE_CFG") {
        double du = 0, ds = 0, bt = 0, bh = 0, da = 0, dd = 0;
        int dm = 3;
        iss >> du >> ds >> bt >> bh >> da >> dm >> dd;
        HxScoreSetConfig(du, ds, bh);
    } else if (cmd == "SCORE_MODE") {
        int mode = 0; iss >> mode;
        if (HxScoreSessionActive()) {
            emit_error("SCORE_MODE_RUNNING", "评分中不能切换评分方案");
            return;
        }
        if (mode < HX_SCORE_OFF || mode > HX_SCORE_SYSTEM) {
            emit_error("SCORE_MODE_INVALID", "评分方案无效");
            return;
        }
        HxScoreSetMode((HxScoreMode)mode);
    } else if (cmd == "SCORE_TANK" || cmd == "SCORE_OBJECT") {
        // 换热器只有一个评分对象，接受命令以保持与液位同形的前端调用。
        int unit = 0; iss >> unit;
        (void)unit;
    } else if (cmd == "SCORE_START") {
        // 冷态判定与液位一致：没在运行、仿真时间还在 0。内核冷态时 paused 为真
        // 只是表示「未推进」，不算运行，所以这里不看 paused。
        if (s->running || std::fabs(s->sim_time) > 1.0e-9) {
            emit_error("SCORE_START_NOT_COLD", "请先回到冷态，再开始评分");
            return;
        }
        if (g_hxScore.mode == HX_SCORE_OFF) {
            emit_error("SCORE_START_MODE_REQUIRED", "请先选择评分方案");
            return;
        }
        HxScoreBeginSession();
        state_changed = true;
    } else if (cmd == "SCORE_FINISH") {
        HxScoreFinishSession();
        score_ended = HxScoreTakeFinishedEvent();
        s->running = false;
        s->paused = false;
        state_changed = true;
    } else if (cmd == "SCORE_END") {
        HxScoreEndSession();
        state_changed = true;
    } else if (cmd == "SAVE") {
        save_state();
    } else if (cmd == "QUIT") {
        save_state();
        emit_state();
        std::exit(0);
    } else {
        emit_error("UNKNOWN_COMMAND", "未知控制命令");
        return;
    }

    if (state_changed && !g_engine.state_path.empty()) save_state();
    emit_state(score_ended);
}

}  // namespace

int main(int argc, char** argv) {
    HxInitScenario(&g_engine.sys, HX_SCENARIO_COOL_480);
    HxScoreInit();
    g_usePidBias = false;

    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--state-file" && i + 1 < argc) {
            g_engine.state_path = argv[++i];
        } else if (arg == "--scenario" && i + 1 < argc) {
            g_engine.scenario = std::atoi(argv[++i]);
            reset_to_cold();
        }
    }
    load_state();

    std::string line;
    while (std::getline(std::cin, line)) process_line(line);
    save_state();
    return 0;
}
