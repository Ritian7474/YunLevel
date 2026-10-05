#pragma once
#include <algorithm>
#include <cmath>
#include <limits>

// SI units. A full, vented gravity pipe discharges to atmosphere; head is the
// upstream free-surface height above the outlet, not the next tank's level.
struct GravityPipe {
    double length_m;
    double diameter_m;
    double roughness_m;
    double minor_loss;
    double valve_loss_full_open;
};

namespace pipe_hydraulics {
constexpr double gravity = 9.81;
constexpr double pi = 3.14159265358979323846;
constexpr double water_viscosity_m2s = 1.004e-6; // water at approximately 20 C

inline bool valid(const GravityPipe& p) {
    return std::isfinite(p.length_m) && p.length_m >= 0.0 &&
        std::isfinite(p.diameter_m) && p.diameter_m > 0.0 &&
        std::isfinite(p.roughness_m) && p.roughness_m >= 0.0 &&
        p.roughness_m < p.diameter_m && std::isfinite(p.minor_loss) &&
        p.minor_loss >= 0.0 && std::isfinite(p.valve_loss_full_open) &&
        p.valve_loss_full_open > 0.0;
}

inline double area(const GravityPipe& p) {
    return pi * p.diameter_m * p.diameter_m / 4.0;
}

inline double friction(double reynolds, double relative_roughness) {
    if (reynolds <= 0.0) return 0.0;
    if (reynolds <= 2000.0) return 64.0 / reynolds;
    // Swamee-Jain approximation, with continuous interpolation across the
    // uncertain transition regime rather than a discontinuous flow jump.
    const double turbulent_re = std::max(4000.0, reynolds);
    const double logarithm = std::log10(relative_roughness / 3.7 +
        5.74 / std::pow(turbulent_re, 0.9));
    const double turbulent = 0.25 / (logarithm * logarithm);
    if (reynolds >= 4000.0) return turbulent;
    const double weight = (reynolds - 2000.0) / 2000.0;
    return (1.0 - weight) * 64.0 / reynolds + weight * turbulent;
}

inline double fixed_loss_head(const GravityPipe& p, double q_m3s) {
    if (q_m3s <= 0.0) return 0.0;
    const double velocity = q_m3s / area(p);
    const double re = velocity * p.diameter_m / water_viscosity_m2s;
    const double loss = friction(re, p.roughness_m / p.diameter_m) *
        p.length_m / p.diameter_m + p.minor_loss;
    return loss * velocity * velocity / (2.0 * gravity);
}

inline double head_loss(const GravityPipe& p, double q_m3s, double opening_pct) {
    if (q_m3s == 0.0) return 0.0;
    if (!valid(p) || !std::isfinite(q_m3s) || q_m3s < 0.0 ||
        !std::isfinite(opening_pct) || opening_pct <= 0.0)
        return std::numeric_limits<double>::infinity();
    const double opening = std::min(100.0, opening_pct) / 100.0;
    const double velocity = q_m3s / area(p);
    return fixed_loss_head(p, q_m3s) + p.valve_loss_full_open /
        (opening * opening) * velocity * velocity / (2.0 * gravity);
}

inline double flow(const GravityPipe& p, double head_m, double opening_pct) {
    if (!valid(p) || !std::isfinite(head_m) || head_m <= 0.0 ||
        !std::isfinite(opening_pct) || opening_pct <= 0.0) return 0.0;
    const double opening = std::min(100.0, opening_pct) / 100.0;
    // Loss-free orifice is an upper bound; positive pipe losses lower flow.
    double lo = 0.0;
    double hi = area(p) * opening * std::sqrt(2.0 * gravity * head_m /
        p.valve_loss_full_open);
    for (int i = 0; i < 40; ++i) {
        const double middle = (lo + hi) / 2.0;
        if (head_loss(p, middle, opening_pct) > head_m) hi = middle;
        else lo = middle;
    }
    return (lo + hi) / 2.0;
}

// Static inverse for teacher feedforward. Infeasible demand returns full open;
// it cannot create flow beyond the available head/pipe capacity.
inline double opening_for_flow(const GravityPipe& p, double head_m, double q_m3s) {
    if (!valid(p) || !std::isfinite(head_m) || head_m <= 0.0 ||
        !std::isfinite(q_m3s) || q_m3s <= 0.0) return 0.0;
    const double remaining = head_m - fixed_loss_head(p, q_m3s);
    if (remaining <= 0.0) return 100.0;
    const double velocity = q_m3s / area(p);
    return std::min(100.0, 100.0 * std::sqrt(p.valve_loss_full_open *
        velocity * velocity / (2.0 * gravity * remaining)));
}
} // namespace pipe_hydraulics
