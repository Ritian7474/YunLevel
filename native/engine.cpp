// YunLevel server-side simulation engine.
// One engine process owns exactly one TankSystem + ScoreState. The web gateway
// communicates with it using one command per line on stdin and one JSON object
// per command on stdout. This keeps the proven simulation core isolated from
// HTTP, account, persistence and teacher-dashboard code.

#include "model.h"
#include "score.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {

constexpr unsigned int STATE_MAGIC = 0x594C5631u; // YLV1
constexpr unsigned int STATE_VERSION = 1u;
constexpr double PI_ENGINE = 3.14159265358979323846;

struct StateHeader {
    unsigned int magic;
    unsigned int version;
    unsigned int sys_bytes;
    unsigned int score_bytes;
    unsigned int bias;
    unsigned int reserved;
    double sim_time;
};

struct Engine {
    TankSystem sys;
    bool bias = false;
    bool paused = false;
    double sim_time = 0.0;
    unsigned long long tick_count = 0;
    std::string state_path;
    bool state_dirty = false;
};

Engine g_engine;
bool g_bias_allowed = true;

double clampd(double v, double lo, double hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

bool read_all(FILE* fp, void* dst, size_t bytes) {
    return bytes == 0 || std::fread(dst, 1, bytes, fp) == bytes;
}

bool write_all(FILE* fp, const void* src, size_t bytes) {
    return bytes == 0 || std::fwrite(src, 1, bytes, fp) == bytes;
}

void open_free_valves() {
    TankSystem* s = &g_engine.sys;
    for (int v = 0; v < N_MV; ++v) {
        if (ValveDriver(s, v) < 0) {
            s->vhand[v] = 100.0;
            *ValveCmdP(s, v) = 100.0;
        }
    }
}

void save_state() {
    if (g_engine.state_path.empty()) return;
    const std::string tmp = g_engine.state_path + ".tmp";
    FILE* fp = std::fopen(tmp.c_str(), "wb");
    if (!fp) return;

    StateHeader h{};
    h.magic = STATE_MAGIC;
    h.version = STATE_VERSION;
    h.sys_bytes = (unsigned int)sizeof(TankSystem);
    h.score_bytes = (unsigned int)sizeof(ScoreState);
    h.bias = g_engine.bias ? 1u : 0u;
    h.sim_time = g_engine.sim_time;

    bool ok = write_all(fp, &h, sizeof(h)) &&
              write_all(fp, &g_engine.sys, sizeof(g_engine.sys)) &&
              write_all(fp, &g_score, sizeof(g_score));
    if (std::fclose(fp) != 0) ok = false;
    if (!ok) {
        std::remove(tmp.c_str());
        return;
    }
    std::remove(g_engine.state_path.c_str());
    if (std::rename(tmp.c_str(), g_engine.state_path.c_str()) != 0)
        std::remove(tmp.c_str());
    else
        g_engine.state_dirty = false;
}

void load_state() {
    if (g_engine.state_path.empty()) return;
    FILE* fp = std::fopen(g_engine.state_path.c_str(), "rb");
    if (!fp) return;

    StateHeader h{};
    bool ok = read_all(fp, &h, sizeof(h));
    TankSystem savedSys{};
    ScoreState savedScore{};
    if (ok && h.magic == STATE_MAGIC && h.version == STATE_VERSION &&
        h.sys_bytes == sizeof(TankSystem) && h.score_bytes == sizeof(ScoreState)) {
        ok = read_all(fp, &savedSys, sizeof(savedSys)) &&
             read_all(fp, &savedScore, sizeof(savedScore));
    } else {
        ok = false;
    }
    std::fclose(fp);
    if (!ok) return;

    g_engine.sys = savedSys;
    g_score = savedScore;
    g_engine.bias = g_bias_allowed && h.bias != 0;
    g_engine.sim_time = h.sim_time;
    g_engine.paused = false;
    g_engine.sys.running = false;
    g_engine.sys.paused = false;
    g_engine.sys.needRecalcLoops = 1;
    g_score.session_just_end = false;
    g_usePidBias = g_engine.bias;
}

void reset_simulation() {
    TankSystem* s = &g_engine.sys;
    const int mode = s->mode;
    const int cm = s->cascade_master;

    LoopCfg loopBak[MAX_LOOPS];
    const int nLoop = s->nLoop;
    for (int i = 0; i < nLoop; ++i) loopBak[i] = s->loop[i];

    LoopCfg otherBak[MAX_LOOPS];
    const int nOther = s->nLoop_other;
    for (int i = 0; i < nOther; ++i) otherBak[i] = s->loop_other[i];
    const int otherMode = s->loop_other_mode;

    CascCfg cascBak[MAX_CASC];
    const int nCasc = s->nCasc;
    for (int i = 0; i < nCasc; ++i) cascBak[i] = s->casc[i];

    const double spf1 = s->spf[0], spf2 = s->spf[1], spf3 = s->spf[2];
    const double sp1 = s->sp1, sp2 = s->sp2, sp3 = s->sp3, setpoint = s->setpoint;

    InitSimulation(s);
    s->mode = mode;
    s->cascade_master = cm;
    for (int i = 0; i < nLoop; ++i) s->loop[i] = loopBak[i];
    s->nLoop = nLoop;
    for (int i = 0; i < nOther; ++i) s->loop_other[i] = otherBak[i];
    s->nLoop_other = nOther;
    s->loop_other_mode = otherMode;
    for (int i = 0; i < nCasc; ++i) s->casc[i] = cascBak[i];
    s->nCasc = nCasc;
    s->spf[0] = spf1; s->spf[1] = spf2; s->spf[2] = spf3;
    s->sp1 = sp1; s->sp2 = sp2; s->sp3 = sp3; s->setpoint = setpoint;
    s->needRecalcLoops = 1;

    ApplyPidGains(s);
    if (mode == MODE_B) {
        for (int c = 0; c < s->nCasc; ++c) {
            PidReset(&s->casc[c].opid, 0.0);
            PidReset(&s->casc[c].ipid, 0.0);
        }
    }
    SyncHandFromValves(s);
    ScoreColdReset();
    g_engine.paused = false;
    g_engine.sim_time = 0.0;
    g_engine.state_dirty = true;
}

void apply_preset() {
    TankSystem* s = &g_engine.sys;
    if (s->running) return;
    if (s->mode == MODE_A) {
        s->sp1 = s->sp2 = s->sp3 = 60.0;
        s->setpoint = 60.0;
        s->pump_cmd = 100.0;
        if (s->nLoop == 0) ApplyRecommendedLoops(s);
        for (int i = 0; i < s->nLoop; ++i) {
            LoopCfg& L = s->loop[i];
            L.pid.manual = false;
            PidReset(&L.pid, LoopFeedforward(s, &L));
        }
    } else {
        s->sp1 = s->sp2 = s->sp3 = 60.0;
        s->spf[0] = s->spf[1] = s->spf[2] = 50.0;
        s->setpoint = 60.0;
        s->pump_cmd = 100.0;
        if (s->nCasc + s->nLoop == 0) ApplyCascadeTemplate(s);
        for (int c = 0; c < s->nCasc; ++c) {
            CascCfg& C = s->casc[c];
            C.opid.manual = false;
            C.ipid.manual = false;
            PidReset(&C.opid, ValveVal(s, C.mv));
            PidReset(&C.ipid, ValveVal(s, C.mv));
        }
        for (int i = 0; i < s->nLoop; ++i) {
            LoopCfg& L = s->loop[i];
            L.pid.manual = false;
            PidReset(&L.pid, 100.0);
        }
        ApplyCascadeGains(s);
    }
    SyncHandFromValves(s);
    open_free_valves();
    s->needRecalcLoops = 1;
    g_engine.state_dirty = true;
}

void apply_high_score_template() {
    TankSystem* s = &g_engine.sys;
    if (s->running) return;
    ApplyHighScoreTemplate(s);
    g_engine.bias = g_bias_allowed;
    g_usePidBias = g_engine.bias;
    open_free_valves();
    g_engine.state_dirty = true;
}

void set_score_mode(int mode) {
    if (ScoreSessionActive()) return;
    if (mode < SCORE_OFF || mode > SCORE_SYSTEM) mode = SCORE_OFF;
    ScoreSetMode((ScoreMode)mode);
    g_engine.state_dirty = true;
}

void set_score_tank(int tank) {
    if (ScoreSessionActive() || g_score.mode != SCORE_TANK) return;
    if (tank < 0) tank = 0;
    if (tank > 2) tank = 2;
    g_score.tank = tank;
    // Match the desktop page behavior: changing the score object resets the
    // evaluation latches while keeping the selected mode and tank.
    const ScoreMode mode = g_score.mode;
    const int keepTank = g_score.tank;
    ScoreColdReset();
    g_score.mode = mode;
    g_score.tank = keepTank;
    g_engine.state_dirty = true;
}

void start_score_session() {
    if (g_engine.sys.running || g_score.mode == SCORE_OFF) return;
    LoopClear(&g_engine.sys);
    CascClear(&g_engine.sys);
    g_engine.sys.nLoop_other = 0;
    g_engine.sys.loop_other_mode = -1;
    reset_simulation();
    ScoreBeginSession();
    g_engine.state_dirty = true;
}

bool set_pid_value(PID* p, double kp, double ti, double td, int action,
                   int manual, double manual_out) {
    if (!p) return false;
    if (std::isnan(ti) || ti == 0.0) return false;
    p->Kp = clampd(kp, 0.0, 1000.0);
    if (ti < 0.0 || std::isinf(ti)) p->Ti = PID_TI_OFF;
    else p->Ti = clampd(ti, 1.0e-9, 1.0e9);
    p->Td = clampd(td, 0.0, 1.0e6);
    p->action = (action < 0) ? -1 : 1;
    p->manual = manual != 0;
    p->manual_out = clampd(manual_out, p->out_min, p->out_max);
    if (p->manual) PidReset(p, p->manual_out);
    g_engine.state_dirty = true;
    return true;
}

void write_level_sp(TankSystem* s, int pv, double value) {
    if (!s) return;
    value = clampd(value, 0.0, 100.0);
    if (pv == 0) s->sp1 = value;
    else if (pv == 1) s->sp2 = value;
    else s->sp3 = value;
}

void write_flow_sp(TankSystem* s, int idx, double value) {
    if (!s || idx < 0 || idx > 2) return;
    s->spf[idx] = clampd(value, 0.0, 100.0);
}

void write_pvx_sp(TankSystem* s, int sel, double value) {
    if (PvxIsFlow(sel)) write_flow_sp(s, sel - N_PV, value);
    else write_level_sp(s, sel, value);
}

void json_begin_array(FILE* fp, const char* key, bool& first) {
    if (!first) std::fputc(',', fp);
    first = false;
    std::fprintf(fp, "\"%s\":[", key);
}

void json_begin_object(FILE* fp, const char* key, bool& first) {
    if (!first) std::fputc(',', fp);
    first = false;
    std::fprintf(fp, "\"%s\":{", key);
}

double pid_ti_out(const PID& p) {
    return PidTiOff(p.Ti) ? -1.0 : p.Ti;
}

void json_num(FILE* fp, const char* key, double v, bool& first) {
    if (!first) std::fputc(',', fp);
    first = false;
    std::fprintf(fp, "\"%s\":", key);
    if (!std::isfinite(v)) std::fputs("null", fp);
    else std::fprintf(fp, "%.10g", v);
}

void json_int(FILE* fp, const char* key, long long v, bool& first) {
    if (!first) std::fputc(',', fp);
    first = false;
    std::fprintf(fp, "\"%s\":%lld", key, v);
}

void json_bool(FILE* fp, const char* key, bool v, bool& first) {
    if (!first) std::fputc(',', fp);
    first = false;
    std::fprintf(fp, "\"%s\":%s", key, v ? "true" : "false");
}

void json_string(FILE* fp, const std::string& value) {
    std::fputc('"', fp);
    for (unsigned char ch : value) {
        switch (ch) {
            case '"': std::fputs("\\\"", fp); break;
            case '\\': std::fputs("\\\\", fp); break;
            case '\n': std::fputs("\\n", fp); break;
            case '\r': std::fputs("\\r", fp); break;
            case '\t': std::fputs("\\t", fp); break;
            default:
                if (ch < 0x20) std::fprintf(fp, "\\u%04x", (unsigned int)ch);
                else std::fputc(ch, fp);
                break;
        }
    }
    std::fputc('"', fp);
}

void emit_error(const char* code, const std::string& message) {
    std::fputs("{\"type\":\"error\",\"ok\":false,\"code\":", stdout);
    json_string(stdout, code);
    std::fputs(",\"message\":", stdout);
    json_string(stdout, message);
    std::fputs("}\n", stdout);
    std::fflush(stdout);
}

std::string valve_label(int mv) {
    const int safe = std::max(0, std::min(mv, N_MV - 1));
    return "FV" + std::to_string(101 + safe);
}

void emit_state(bool score_ended) {
    TankSystem* s = &g_engine.sys;
    FILE* fp = stdout;
    std::fputs("{\"type\":\"state\",\"ok\":true", fp);
    bool first = false;
    json_num(fp, "sim_time", s->sim_time, first);
    json_bool(fp, "running", s->running, first);
    json_bool(fp, "paused", g_engine.paused || s->paused, first);
    json_bool(fp, "bias", g_engine.bias, first);
    json_int(fp, "mode", s->mode, first);
    json_int(fp, "master", s->cascade_master, first);
    json_bool(fp, "scoreEnded", score_ended, first);

    json_num(fp, "h1", LevelPct(s, 0), first);
    json_num(fp, "h2", LevelPct(s, 1), first);
    json_num(fp, "h3", LevelPct(s, 2), first);
    json_num(fp, "h1mm", s->h1_meas, first);
    json_num(fp, "h2mm", s->h2_meas, first);
    json_num(fp, "h3mm", s->h3_meas, first);
    json_num(fp, "sp1", s->sp1, first);
    json_num(fp, "sp2", s->sp2, first);
    json_num(fp, "sp3", s->sp3, first);
    json_num(fp, "spf1", s->spf[0], first);
    json_num(fp, "spf2", s->spf[1], first);
    json_num(fp, "spf3", s->spf[2], first);
    json_num(fp, "qin", s->qin, first);
    json_num(fp, "q12", s->q12, first);
    json_num(fp, "q23", s->q23, first);
    json_num(fp, "qout", s->qout, first);
    json_num(fp, "pump", s->pump, first);
    json_num(fp, "pumpCmd", s->pump_cmd, first);
    json_num(fp, "fv101", s->valve_in, first);
    json_num(fp, "fv102", s->valve_12, first);
    json_num(fp, "fv103", s->valve_23, first);
    json_num(fp, "fv104", s->valve_out, first);
    json_num(fp, "fv101cmd", s->valve_in_cmd, first);
    json_num(fp, "fv102cmd", s->valve_12_cmd, first);
    json_num(fp, "fv103cmd", s->valve_23_cmd, first);
    json_num(fp, "fv104cmd", s->valve_out_cmd, first);
    json_num(fp, "pi101", s->pi101_kpa, first);

    json_int(fp, "nLoop", s->nLoop, first);
    json_begin_array(fp, "loops", first);
    for (int i = 0; i < s->nLoop; ++i) {
        if (i) std::fputc(',', fp);
        const LoopCfg& L = s->loop[i];
        std::fputs("{", fp);
        bool b = true;
        json_int(fp, "pv", L.pv, b);
        json_int(fp, "mv", L.mv, b);
        json_bool(fp, "enabled", L.enabled, b);
        json_bool(fp, "manual", L.pid.manual, b);
        json_int(fp, "action", L.pid.action, b);
        json_num(fp, "sp", SpPct(s, L.pv), b);
        json_num(fp, "kp", L.pid.Kp, b);
        json_num(fp, "ti", pid_ti_out(L.pid), b);
        json_num(fp, "td", L.pid.Td, b);
        json_num(fp, "out", L.pid.out, b);
        json_num(fp, "manualOut", L.pid.manual_out, b);
        json_num(fp, "e", L.pid.last_e, b);
        json_num(fp, "pTerm", L.pid.last_p_term, b);
        json_num(fp, "iTerm", L.pid.last_i_term, b);
        json_num(fp, "dTerm", L.pid.last_d_term, b);
        json_num(fp, "uBias", L.pid.last_u_bias, b);
        json_num(fp, "uRaw", L.pid.last_u_raw, b);
        json_num(fp, "pvValue", L.pid.last_pv, b);
        std::fputs("}", fp);
    }
    std::fputs("]", fp);

    json_int(fp, "nCasc", s->nCasc, first);
    json_begin_array(fp, "cascades", first);
    for (int c = 0; c < s->nCasc; ++c) {
        if (c) std::fputc(',', fp);
        const CascCfg& C = s->casc[c];
        std::fputs("{", fp);
        bool b = true;
        json_int(fp, "mv", C.mv, b);
        json_int(fp, "outer", C.outer, b);
        json_int(fp, "inner", C.inner, b);
        json_bool(fp, "enabled", C.enabled, b);
        json_bool(fp, "outerManual", C.opid.manual, b);
        json_bool(fp, "innerManual", C.ipid.manual, b);
        json_int(fp, "outerAction", C.opid.action, b);
        json_int(fp, "innerAction", C.ipid.action, b);
        json_num(fp, "outerSp", PvxSp(s, C.outer), b);
        json_num(fp, "innerSp", PvxSp(s, C.inner), b);
        json_num(fp, "outerKp", C.opid.Kp, b);
        json_num(fp, "outerTi", pid_ti_out(C.opid), b);
        json_num(fp, "outerTd", C.opid.Td, b);
        json_num(fp, "innerKp", C.ipid.Kp, b);
        json_num(fp, "innerTi", pid_ti_out(C.ipid), b);
        json_num(fp, "innerTd", C.ipid.Td, b);
        json_num(fp, "outerOut", C.opid.out, b);
        json_num(fp, "innerOut", C.ipid.out, b);
        json_num(fp, "outerE", C.opid.last_e, b);
        json_num(fp, "outerP", C.opid.last_p_term, b);
        json_num(fp, "outerI", C.opid.last_i_term, b);
        json_num(fp, "outerD", C.opid.last_d_term, b);
        json_num(fp, "innerE", C.ipid.last_e, b);
        json_num(fp, "innerP", C.ipid.last_p_term, b);
        json_num(fp, "innerI", C.ipid.last_i_term, b);
        json_num(fp, "innerD", C.ipid.last_d_term, b);
        json_num(fp, "outerPvValue", C.opid.last_pv, b);
        json_num(fp, "innerPvValue", C.ipid.last_pv, b);
        std::fputs("}", fp);
    }
    std::fputs("]", fp);

    json_begin_object(fp, "score", first);
    bool scoreFirst = true;
    json_int(fp, "mode", (int)g_score.mode, scoreFirst);
    json_int(fp, "tank", g_score.tank, scoreFirst);
    json_bool(fp, "active", g_score.session_active, scoreFirst);
    json_bool(fp, "finished", g_score.session_finished, scoreFirst);
    json_num(fp, "sessionT", g_score.session_t, scoreFirst);
    json_num(fp, "runT", g_score.run_t, scoreFirst);
    json_num(fp, "activeT", g_score.active_t, scoreFirst);
    {
        const ScoreCategory& cat = (g_score.mode == SCORE_TANK)
            ? g_score.tank_score[(g_score.tank < 0 ? 0 : (g_score.tank > 2 ? 2 : g_score.tank))].cat
            : g_score.system_score.cat;
        json_num(fp, "total", cat.total, scoreFirst);
        json_num(fp, "operation", cat.operation, scoreFirst);
        json_num(fp, "control", cat.control, scoreFirst);
        json_num(fp, "safety", cat.safety, scoreFirst);
        json_num(fp, "benefit", cat.benefit, scoreFirst);
        json_num(fp, "target", cat.target, scoreFirst);
        json_num(fp, "safetyDeduction", cat.safety_deduction, scoreFirst);
        json_num(fp, "durationS", ScoreSessionDuration(), scoreFirst);
    }
    json_num(fp, "syncSettle", g_score.system_score.sync_settle_s, scoreFirst);
    json_num(fp, "flowBalance", g_score.system_score.flow_balance_lmin, scoreFirst);
    json_num(fp, "innerMae", g_score.system_score.inner_mae_pct, scoreFirst);
    json_num(fp, "outflow", g_score.system_score.outflow_l, scoreFirst);
    json_num(fp, "efficiency", g_score.system_score.efficiency, scoreFirst);
    std::fputs("},\"tanks\":[", fp);
    for (int t = 0; t < 3; ++t) {
        if (t) std::fputc(',', fp);
        const TankScore& q = g_score.tank_score[t];
        std::fputs("{", fp);
        bool b = true;
        json_num(fp, "total", q.cat.total, b);
        json_num(fp, "operation", q.cat.operation, b);
        json_num(fp, "control", q.cat.control, b);
        json_num(fp, "safety", q.cat.safety, b);
        json_num(fp, "benefit", q.cat.benefit, b);
        json_bool(fp, "built", q.loop_built, b);
        json_bool(fp, "auto", q.loop_auto, b);
        json_bool(fp, "settled", q.settled, b);
        json_num(fp, "mae", q.mae_pct, b);
        json_num(fp, "settle", q.settle_s, b);
        json_num(fp, "overshoot", q.overshoot_pct, b);
        json_num(fp, "lowTime", q.low_time_s, b);
        json_num(fp, "highTime", q.high_time_s, b);
        json_int(fp, "overflow", q.overflow_events, b);
        json_int(fp, "dry", q.dry_events, b);
        json_num(fp, "outflow", q.outflow_l, b);
        json_num(fp, "efficiency", q.efficiency, b);
        std::fputs("}", fp);
    }
    std::fputs("]}\n", fp);
    std::fflush(fp);
}

void process_line(const std::string& line) {
    std::istringstream iss(line);
    std::string cmd;
    if (!(iss >> cmd)) return;

    bool state_changed = false;
    bool score_ended = false;

    if (cmd == "STATE") {
        // no-op
    } else if (cmd == "TICK") {
        int run = 0;
        iss >> run;
        if (run && !g_engine.paused && !g_engine.sys.paused) {
            g_engine.sys.running = true;
            UpdateSimulation(&g_engine.sys);
            g_engine.sim_time = g_engine.sys.sim_time;
        }
        ScoreTick(&g_engine.sys, DT_MAIN_S);
        score_ended = ScoreTakeFinishedEvent();
        g_engine.tick_count++;
        if (g_engine.tick_count % 30ull == 0ull) {
            save_state();
        }
    } else if (cmd == "START") {
        g_engine.sys.running = true;
        g_engine.sys.paused = false;
        g_engine.paused = false;
        ScoreBeginRun(&g_engine.sys);
        state_changed = true;
    } else if (cmd == "PAUSE") {
        g_engine.paused = !g_engine.paused;
        g_engine.sys.paused = g_engine.paused;
        state_changed = true;
    } else if (cmd == "DEACTIVATE") {
        // Restored projects return to the safer stopped state without resetting them.
        g_engine.sys.running = false;
        g_engine.sys.paused = false;
        g_engine.paused = false;
        state_changed = true;
    } else if (cmd == "RESET") {
        reset_simulation();
        state_changed = true;
    } else if (cmd == "SET_BIAS") {
        int v = 0; iss >> v;
        g_engine.bias = g_bias_allowed && v != 0;
        g_usePidBias = g_engine.bias;
        state_changed = true;
    } else if (cmd == "SET_MODE") {
        int mode = 0; iss >> mode;
        if (mode != MODE_A && mode != MODE_B) {
            emit_error("MODE_INVALID", "控制方案无效");
            return;
        }
        if (g_engine.sys.running) {
            emit_error("MODE_RUNNING", "运行中不能切换单回路/串级方案");
            return;
        }
        if (mode != g_engine.sys.mode) {
            SwitchLoopConfigMode(&g_engine.sys, mode);
            ApplyPidGains(&g_engine.sys);
            if (mode == MODE_B) ApplyCascadeGains(&g_engine.sys);
            ScoreColdReset();
            g_engine.sys.needRecalcLoops = 1;
            state_changed = true;
        }
    } else if (cmd == "SET_PUMP") {
        double v = 0.0; iss >> v;
        g_engine.sys.pump_cmd = clampd(v, 0.0, 100.0);
        state_changed = true;
    } else if (cmd == "SET_VALVE") {
        int mv = 0; double v = 0.0; iss >> mv >> v;
        if (mv >= 0 && mv < N_MV) {
            g_engine.sys.vhand[mv] = clampd(v, 0.0, 100.0);
            if (ValveDriver(&g_engine.sys, mv) < 0)
                *ValveCmdP(&g_engine.sys, mv) = g_engine.sys.vhand[mv];
            state_changed = true;
        }
    } else if (cmd == "SET_SP") {
        int pv = 0; double v = 0.0; iss >> pv >> v;
        write_level_sp(&g_engine.sys, pv, v);
        state_changed = true;
    } else if (cmd == "SET_FLOW_SP") {
        int idx = 0; double v = 0.0; iss >> idx >> v;
        write_flow_sp(&g_engine.sys, idx, v);
        state_changed = true;
    } else if (cmd == "SET_PVX_SP") {
        int sel = 0; double v = 0.0; iss >> sel >> v;
        write_pvx_sp(&g_engine.sys, sel, v);
        state_changed = true;
    } else if (cmd == "LOOP_ADD") {
        int pv = 0, mv = 0; iss >> pv >> mv;
        if (pv < 0 || pv >= N_PV || mv < 0 || mv >= N_MV) {
            emit_error("LOOP_INVALID_SELECTION", "被控量或阀门编号无效");
            return;
        }
        const int result = LoopAdd(&g_engine.sys, pv, mv);
        if (result < 0) {
            if (result == LOOP_ADD_DUPLICATE) {
                emit_error("LOOP_DUPLICATE", "该液位与阀门的回路已经存在");
            } else if (result == LOOP_ADD_MV_CONFLICT) {
                emit_error("LOOP_MV_CONFLICT", valve_label(mv) + " 已被其他回路占用，请换阀门或先删除原回路");
            } else {
                emit_error("LOOP_FULL", "回路数量已达上限，最多允许 4 条");
            }
            return;
        }
        state_changed = true;
    } else if (cmd == "LOOP_DEL") {
        int idx = 0; iss >> idx;
        LoopDel(&g_engine.sys, idx);
        state_changed = true;
    } else if (cmd == "LOOP_CLEAR") {
        LoopClear(&g_engine.sys);
        state_changed = true;
    } else if (cmd == "TEMPLATE_A") {
        ApplyRecommendedLoops(&g_engine.sys);
        state_changed = true;
    } else if (cmd == "CASC_ADD") {
        int mv = 0, outer = 0, inner = 0; iss >> mv >> outer >> inner;
        if (g_engine.sys.mode != MODE_B) {
            emit_error("CASC_MODE_REQUIRED", "请先切换到串级方案");
            return;
        }
        if (mv < 0 || mv >= N_MV || outer < 0 || outer >= N_PVX || inner < 0 || inner >= N_PVX) {
            emit_error("CASC_INVALID_SELECTION", "主环、副环或阀门编号无效");
            return;
        }
        const int result = CascAdd(&g_engine.sys, mv, outer, inner);
        if (result < 0) {
            if (result == CASC_ADD_DUPLICATE) {
                emit_error("CASC_DUPLICATE", "该阀门与主副环组合已经存在");
            } else if (result == CASC_ADD_MV_CONFLICT) {
                emit_error("CASC_MV_CONFLICT", valve_label(mv) + " 已被其他回路占用，请换阀门或先删除原回路");
            } else {
                emit_error("CASC_FULL", "回路数量已达上限，串级与单回路合计最多 4 条");
            }
            return;
        }
        state_changed = true;
    } else if (cmd == "CASC_DEL") {
        int idx = 0; iss >> idx;
        CascDel(&g_engine.sys, idx);
        state_changed = true;
    } else if (cmd == "CASC_CLEAR") {
        CascClear(&g_engine.sys);
        state_changed = true;
    } else if (cmd == "TEMPLATE_B") {
        ApplyCascadeTemplate(&g_engine.sys);
        state_changed = true;
    } else if (cmd == "PRESET") {
        apply_preset();
        state_changed = true;
    } else if (cmd == "HIGH_SCORE") {
        apply_high_score_template();
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
        bool ok = false;
        if (kind == "loop" && idx >= 0 && idx < g_engine.sys.nLoop) {
            ok = set_pid_value(&g_engine.sys.loop[idx].pid, kp, ti, td, action, manual, manualOut);
        } else if (kind == "outer" && idx >= 0 && idx < g_engine.sys.nCasc) {
            ok = set_pid_value(&g_engine.sys.casc[idx].opid, kp, ti, td, action, manual, manualOut);
        } else if (kind == "inner" && idx >= 0 && idx < g_engine.sys.nCasc) {
            ok = set_pid_value(&g_engine.sys.casc[idx].ipid, kp, ti, td, action, manual, manualOut);
        }
        if (!ok) {
            emit_error("PID_TARGET_INVALID", "PID 目标回路不存在");
            return;
        }
        state_changed = true;
    } else if (cmd == "SCORE_CFG") {
        double du = 0, ds = 0, bt = 0, bh = 0, da = 0, dd = 0;
        int dm = 3;
        iss >> du >> ds >> bt >> bh >> da >> dm >> dd;
        ScoreSetConfig(du, ds, bt, bh, da, dm, dd);
    } else if (cmd == "SCORE_MODE") {
        int mode = 0; iss >> mode;
        if (ScoreSessionActive()) {
            emit_error("SCORE_MODE_RUNNING", "评分中不能切换评分方案");
            return;
        }
        if (mode < SCORE_OFF || mode > SCORE_SYSTEM) {
            emit_error("SCORE_MODE_INVALID", "评分方案无效");
            return;
        }
        set_score_mode(mode);
    } else if (cmd == "SCORE_TANK") {
        int tank = 0; iss >> tank;
        set_score_tank(tank);
    } else if (cmd == "SCORE_START") {
        if (g_engine.sys.running || g_engine.paused || std::fabs(g_engine.sys.sim_time) > 1.0e-9) {
            emit_error("SCORE_START_NOT_COLD", "请先回到冷态，再开始评分");
            return;
        }
        if (g_score.mode == SCORE_OFF) {
            emit_error("SCORE_START_MODE_REQUIRED", "请先选择评分方案");
            return;
        }
        start_score_session();
        state_changed = true;
    } else if (cmd == "SCORE_FINISH") {
        ScoreFinishSession();
        score_ended = ScoreTakeFinishedEvent();
        g_engine.sys.running = false;
        g_engine.sys.paused = false;
        g_engine.paused = false;
        state_changed = true;
    } else if (cmd == "SCORE_END") {
        ScoreEndSession();
        state_changed = true;
    } else if (cmd == "SAVE") {
        save_state();
    } else if (cmd == "QUIT") {
        save_state();
        emit_state(false);
        std::exit(0);
    } else {
        emit_error("UNKNOWN_COMMAND", "未知控制命令");
        return;
    }

    if (state_changed && g_engine.state_path.size()) {
        // Commands are infrequent; keeping a checkpoint after each one makes
        // browser reconnects and server restarts predictable.
        save_state();
    }
    emit_state(score_ended);
}

} // namespace

int main(int argc, char** argv) {
    InitSimulation(&g_engine.sys);
    ScoreInit();
    g_usePidBias = false;
    g_engine.sys.running = false;
    g_engine.sys.paused = false;
    g_engine.paused = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--state-file" && i + 1 < argc) {
            g_engine.state_path = argv[++i];
        } else if (arg == "--no-pid-bias") {
            g_bias_allowed = false;
        }
    }
    load_state();

    std::string line;
    while (std::getline(std::cin, line)) {
        process_line(line);
    }
    save_state();
    return 0;
}
