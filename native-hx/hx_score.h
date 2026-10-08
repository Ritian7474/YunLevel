#pragma once
// hx_score.h -- 换热器评分。
//
// 与液位评分同形：同一套四类权重（操作 20 / 控制 50 / 安全 20 / 效益 10），
// 同一套会话语义（选方案 -> 开始评分 -> 限时到点封存），
// 同形 JSON（score + tanks[]），所以教师端与学生端的评分页不需要模型分支。
#include "hx_model.h"

// 教师可配限时/带宽（SCORE_CFG）
extern double HX_SCORE_DURATION_S;
extern double HX_SCORE_DURATION_SYS;
extern double HX_BAND_TAIL_RATIO;
extern double HX_TARGET_BAND_C; // 目标带宽（℃），教师 SCORE_CFG 可配

enum HxScoreMode {
    HX_SCORE_OFF = 0,
    HX_SCORE_UNIT = 1,      // 单回路评分：只看出口温度 TI1104 这一条回路
    HX_SCORE_SYSTEM = 2     // 系统评分：含串级副环跟踪与整体经济性
};

// 评分对象只有一个（E1102 换热器），保留 unit 字段是为了和液位 score.tank 同形。
struct HxScoreCategory {
    double operation;
    double target;
    double control;
    double safety;
    double benefit;
    double safety_deduction;
    double total;
};

struct HxUnitScore {
    HxScoreCategory cat;
    bool loop_built;
    bool loop_auto;
    bool settled;
    double mae_c;            // 出口温度平均绝对偏差 (℃)
    double settle_s;         // 整定时间 (s)
    double overshoot_c;      // 最大超调 (℃)
    double over_time_s;      // 超温累计
    double under_time_s;     // 欠温累计
    double steam_sat_s;      // 蒸汽阀饱和累计
    double water_cut_s;      // 冷却水断流累计
    double ripple_c;         // 稳态波动 (℃)
    double fuel_kg;
    double steam_kg;
    double efficiency;       // 理想燃料单耗 / 实际燃料单耗
};

struct HxScoreState {
    HxScoreMode mode;
    int unit;

    bool run_begin;
    bool session_active;
    double session_t;
    bool session_finished;
    bool session_just_end;
    bool control_active;
    double run_t;
    double active_t;
    double start_t;

    bool start_latch;
    bool built_latch;
    bool auto_latch;
    bool settle_latch;
    double settle_time;
    double settle_hold;
    double max_temp;

    // 最近 300 拍出口温度窗口，用于 MAE / 波动。
    double temp_win[300];
    double err_win[300];
    int err_head;
    int err_count;

    bool armed;
    bool reached_sp;         // 首次进入给定附近后才开始统计超调
    bool over_active;
    bool under_active;
    double over_time;
    double under_time;
    bool over_latch;         // 超温事件按「连续超温段」计次
    double steam_sat_time;
    double water_cut_time;
    int over_events;

    double fuel_used_kg;
    double steam_produced_kg;
    double water_used_kg;

    // 串级副环跟踪偏差累计（按量程百分比）。
    double inner_err_sum_pct;
    int inner_err_n;

    HxUnitScore unit_score;
};

extern HxScoreState g_hxScore;

void HxScoreInit();
void HxScoreSetConfig(double dur_unit, double dur_sys, double band_hx);
double HxScoreSessionDuration();
void HxScoreColdReset();
void HxScoreBeginSession();
void HxScoreEndSession();
void HxScoreFinishSession();
bool HxScoreSessionActive();
bool HxScoreSessionFinished();
bool HxScoreTakeFinishedEvent();
void HxScoreBeginRun(const HxSystem* s);
void HxScoreTick(const HxSystem* s, double dt);
void HxScoreSetMode(HxScoreMode mode);
