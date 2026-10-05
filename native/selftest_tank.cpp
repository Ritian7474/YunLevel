#include "model.h"
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <limits>
#include <cstring>

namespace {
int failures = 0;
void check(bool ok, const char* name) {
    std::printf("%s %s\n", ok ? "OK  " : "FAIL", name);
    if (!ok) ++failures;
}
bool near(double a, double b, double relative = 1e-8) {
    return std::fabs(a - b) <= relative * std::max(1e-12, std::fabs(b));
}

struct Metrics {
    double mae = 0.0, tail_mae = 0.0, overshoot = 0.0;
    double final_level = 0.0, balance = 0.0;
    int overflow = 0, settle = -1;
};

Metrics run(double kp, double ti, double td) {
    auto s = std::make_unique<TankSystem>();
    InitSimulation(s.get());
    s->sp3 = 50.0;
    s->pump_cmd = 60.0;
    for (int v = 1; v < N_MV; ++v) s->vhand[v] = 100.0;
    const int index = LoopAdd(s.get(), 2, 0); // LI103 -> FV101, through all 3 tanks
    PID& p = s->loop[index].pid;
    p.Kp = kp; p.Ti = ti; p.Td = td;
    p.manual = false;
    s->running = true;
    g_usePidBias = false;
    Metrics m;
    int last_outside = 0;
    constexpr int duration = 1500;
    for (int t = 1; t <= duration; ++t) {
        UpdateSimulation(s.get());
        const double level = s->h3 / L_MAX_MM * 100.0;
        const double error = std::fabs(level - 50.0);
        m.mae += error / duration;
        if (t > duration - 300) m.tail_mae += error / 300.0;
        m.overshoot = std::max(m.overshoot, level - 50.0);
        if (error > 2.0) last_outside = t;
        for (int i = 0; i < 3; ++i) m.balance = std::max(m.balance, std::fabs(s->balance_err[i]));
    }
    m.final_level = s->h3 / L_MAX_MM * 100.0;
    m.overflow = s->overflow_count;
    if (last_outside <= duration - 120) m.settle = last_outside + 1;
    return m;
}

void hydraulic_checks() {
    using namespace pipe_hydraulics;
    const GravityPipe p = GRAVITY_PIPES[0];
    const double q = flow(p, 0.5, 100.0);
    check(q > 0.0 && std::isfinite(q), "positive flow at available head");
    check(flow(p, 0.0, 100.0) == 0.0 && flow(p, -0.5, 100.0) == 0.0,
        "no water head means no gravity outflow");
    check(flow(p, 0.5, 0.0) == 0.0, "closed valve stops flow");
    check(std::isinf(head_loss(p, q, 0.0)), "closed valve cannot pass positive flow");
    check(flow(p, 0.5, 200.0) == q, "opening clamps at 100 percent");
    check(flow(p, std::numeric_limits<double>::quiet_NaN(), 100.0) == 0.0,
        "invalid head cannot poison tank states");
    GravityPipe invalid = p; invalid.diameter_m = 0.0;
    check(flow(invalid, 0.5, 100.0) == 0.0, "invalid geometry fails closed");
    GravityPipe longer = p; longer.length_m *= 2.0;
    GravityPipe narrower = p; narrower.diameter_m *= 0.8;
    GravityPipe rougher = p; rougher.roughness_m *= 20.0;
    check(flow(longer, 0.5, 100.0) < q, "longer pipe reduces flow");
    check(flow(narrower, 0.5, 100.0) < q, "smaller diameter reduces flow");
    check(flow(rougher, 0.5, 100.0) < q, "roughness raises turbulent resistance");
    check(flow(p, 0.8, 100.0) > q, "higher head increases flow");
    check(flow(p, 0.5, 40.0) < q, "lower opening reduces flow");
    GravityPipe orifice = p; orifice.length_m = orifice.minor_loss = 0.0;
    const double analytic = area(orifice) * CD_ORIFICE * std::sqrt(2.0 * gravity * 0.5) * 0.4;
    check(near(flow(orifice, 0.5, 40.0), analytic), "zero pipe loss recovers analytic orifice law");
    const double laminar_q = 500.0 * water_viscosity_m2s / p.diameter_m * area(p);
    const double expected = 128.0 * water_viscosity_m2s * p.length_m * laminar_q /
        (pi * gravity * std::pow(p.diameter_m, 4.0));
    GravityPipe laminar = p; laminar.minor_loss = 0.0;
    check(near(fixed_loss_head(laminar, laminar_q), expected), "laminar friction matches Poiseuille law");
    bool consistent = true, monotonic = true;
    for (double h : {0.001, 0.01, 0.1, 0.5, 1.0}) {
        double previous = 0.0;
        for (double u : {1.0, 10.0, 30.0, 60.0, 100.0}) {
            const double f = flow(p, h, u);
            consistent &= near(head_loss(p, f, u), h) && near(opening_for_flow(p, h, f), u);
            monotonic &= f > previous; previous = f;
        }
    }
    check(consistent, "flow/head/inverse remain consistent across regimes");
    check(monotonic, "valve-flow relationship remains monotonic across regimes");
    check(opening_for_flow(p, 0.5, q * 2.0) == 100.0, "infeasible demand saturates at full opening");
    check(GravityPipeQ(-1, 0.5, 100.0) == 0.0, "invalid segment fails closed");
    std::printf("FULL_OPEN_50%%_LMIN %.6f %.6f %.6f\n",
        GravityPipeQ(0, 0.5, 100.0) * M3S2LMIN,
        GravityPipeQ(1, 0.5, 100.0) * M3S2LMIN,
        GravityPipeQ(2, 0.5, 100.0) * M3S2LMIN);
}

void plant_checks() {
    auto s = std::make_unique<TankSystem>();
    InitSimulation(s.get());
    s->running = true;
    for (int t = 0; t < 60; ++t) UpdateSimulation(s.get());
    check(s->h1 == 0.0 && s->h2 == 0.0 && s->h3 == 0.0,
        "empty stopped feed remains empty without NaN");

    // Flow and feedforward share one equation, including the nonlinear
    // opening-vs-total-flow relationship of a pipe in series with a valve.
    const double demand = GravityPipeQ(2, 0.5, 100.0);
    s->sp1 = s->sp2 = s->sp3 = 50.0;
    s->hs[0] = s->hs[1] = s->hs[2] = 0.5;
    s->pump = 60.0;
    s->valve_in = demand / (0.6 * Q_PUMP_MAX_LMIN * LMIN2M3S) * 100.0;
    s->valve_12 = pipe_hydraulics::opening_for_flow(GRAVITY_PIPES[0], 0.5, demand);
    s->valve_23 = pipe_hydraulics::opening_for_flow(GRAVITY_PIPES[1], 0.5, demand);
    s->valve_out = 100.0;
    bool inverse_ok = true;
    for (int pv = 0; pv < 3; ++pv) {
        LoopCfg inlet{}; inlet.pv = pv; inlet.mv = pv;
        LoopCfg outlet{}; outlet.pv = pv; outlet.mv = pv + 1;
        inverse_ok &= near(LoopFeedforward(s.get(), &inlet), ValveVal(s.get(), pv));
        inverse_ok &= near(LoopFeedforward(s.get(), &outlet), ValveVal(s.get(), pv + 1));
    }
    check(inverse_ok, "steady-state flow and teacher feedforward are consistent");

    InitSimulation(s.get());
    s->running = true;
    s->pump_cmd = 100.0;
    for (int v = 0; v < N_MV; ++v) s->vhand[v] = 100.0;
    for (int t = 0; t < 300; ++t) UpdateSimulation(s.get());
    double residual = 0.0;
    for (int i = 0; i < 3; ++i) residual = std::max(residual,
        std::fabs(s->vol0[i] + s->vol_in[i] - s->vol_out[i] - s->hs[i] * TankAreaM2()));
    check(s->overflow_count > 0 && s->overflow_volume_l > 0.0, "overflow boundary exercised");
    check(residual < 1e-10, "water balance includes overflow at each tank");
    const double supplied = s->vol_in[0] * 1000.0;
    const double stored = (s->hs[0] + s->hs[1] + s->hs[2]) * TankAreaM2() * 1000.0;
    const double drained = s->vol_out[2] * 1000.0; // includes T3 overflow
    check(s->overflow_volume_l < supplied && stored + drained <= supplied + 1e-7,
        "overflow volume uses litres, with no manufactured water");

    InitSimulation(s.get());
    s->running = true;
    s->hs[0] = 1e-7; s->vol0[0] = s->hs[0] * TankAreaM2();
    for (int v = 1; v < N_MV; ++v) s->vhand[v] = 100.0;
    for (int t = 0; t < 120; ++t) UpdateSimulation(s.get());
    residual = 0.0;
    for (int i = 0; i < 3; ++i) residual = std::max(residual,
        std::fabs(s->vol0[i] + s->vol_in[i] - s->vol_out[i] - s->hs[i] * TankAreaM2()));
    check(residual < 1e-12, "near-empty discharge conserves water");
}
} // namespace

int main(int argc, char** argv) {
    if (argc == 2 && std::strcmp(argv[1], "--sweep") == 0) {
        std::puts("Kp,Ti_s,Td_s,MAE_pct,Tail_MAE_pct,Overshoot_pct,Final_pct,Settle_s,Overflow,Balance_pct");
        for (double kp : {0.1, 0.3, 0.5, 0.7, 1.0, 3.0, 10.0}) {
            for (double ti : {100.0, 300.0, 500.0, 700.0, 1000.0, 1500.0, 3000.0}) {
                for (double td : {0.0, 60.0, 120.0, 240.0}) {
                    const Metrics m = run(kp, ti, td);
                    std::printf("%.2f,%.0f,%.0f,%.4f,%.4f,%.4f,%.4f,%d,%d,%.9f\n",
                        kp, ti, td, m.mae, m.tail_mae, m.overshoot, m.final_level, m.settle, m.overflow, m.balance);
                }
            }
        }
    } else if (argc == 1) {
        hydraulic_checks();
        plant_checks();
        const Metrics tuned = run(0.5, 700.0, 120.0);
        const Metrics slow = run(0.1, 3000.0, 0.0);
        const Metrics aggressive = run(3.0, 100.0, 60.0);
        check(tuned.settle > 0 && tuned.tail_mae < 1.0 && tuned.overshoot < 2.0 && tuned.overflow == 0,
            "reasonable PID reaches and holds the target without overflow");
        check(tuned.balance < 1e-6, "controlled run conserves water");
        check(slow.settle < 0 && slow.tail_mae > 20.0, "conservative PID remains observably slow");
        check(aggressive.overshoot > 10.0 && aggressive.overflow > 0,
            "aggressive PID is distinguished by overshoot and overflow");
    } else {
        std::fputs("usage: selftest_tank [--sweep]\n", stderr);
        return EXIT_FAILURE;
    }
    return failures ? EXIT_FAILURE : EXIT_SUCCESS;
}
