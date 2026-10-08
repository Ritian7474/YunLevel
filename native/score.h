#pragma once
#include "model.h"

enum ScoreMode {
    SCORE_OFF = 0,
    SCORE_TANK = 1,
    SCORE_SYSTEM = 2
};

struct ScoreCategory {
    double operation;
    double target;          // 尾段目标范围（0.35T）
    double control;         // 控制品质 + 系统扰动恢复
    double safety;          // 保留字段：安全剩余分（展示用，0=仅扣分）
    double benefit;
    double safety_deduction;
    double total;
};

struct TankScore {
    ScoreCategory cat;
    bool loop_built;
    bool loop_auto;
    bool settled;
    double mae_pct;
    double settle_s;
    double overshoot_pct;
    double low_time_s;
    double high_time_s;
    int overflow_events;
    int dry_events;
    double outflow_l;
    double efficiency;
};

struct SystemScore {
    ScoreCategory cat;
    bool all_built;
    bool all_auto;
    double sync_settle_s;
    double flow_balance_lmin;
    double inner_mae_pct;
    double outflow_l;
    double efficiency;
};

struct ScoreState {
    ScoreMode mode;
    int tank;

    bool run_begin;
    bool session_active;      // 评分会话：点「开始评分」后为真，回到冷态后结束
    double session_t;         // 评分时间（s）：从「开始评分」起实时累加
    bool session_finished;    // 评分限时已到：会话自动结束，成绩封存
    bool session_just_end;    // 内部：本拍刚结束（界面用，取出即清）
    bool control_active;
    double run_t;
    double active_t;
    double start_t;

    bool start_latch;
    bool built_latch[3];
    bool auto_latch[3];
    double auto_time[3];
    bool settle_latch[3];
    double settle_time[3];
    double settle_hold[3];
    double max_level[3];

    // Last 300 control samples, evaluated once per score heartbeat.
    double err_win[3][300];
    int err_head[3];
    int err_count[3];

    bool low_active[3];
    bool armed[3];            // 投运判定：液位首次进入正常区间(>=7%FS)后才开始安全评判
    bool high_active[3];
    double low_time[3];
    double high_time[3];
    bool overflow_latch[3];
    bool dry_latch[3];
    int overflow_events[3];
    int dry_events[3];

    double outflow_volume_l[3];
    double inflow_volume_l[3];
    double ref_outflow_volume_l[3];
    double feed_volume_l;                    // 累计给水量（FV101 阀后实际流量，用于给水利用率）

    double flow_balance_sum;
    int flow_balance_n;
    double inner_err_sum_pct;
    int inner_err_n;

    TankScore tank_score[3];
    SystemScore system_score;

    // 尾段目标范围：仅在 session_t > 0.65*T 起累计在带时间
    double band_tail_time[3];
    double band_tail_window;
    double dur_unit_s;   // 单对象限时（教师可配）
    double dur_sys_s;    // 系统限时（教师可配）
    double band_tank_pct; // 液位目标带 %FS
    double band_hx_c;    // 换热目标带 ℃（hx 用）
    bool band_tail_init;

    // 教师可配扰动（液位系统）：到点对某阀阶跃
    bool disturb_enable;
    double disturb_at_s;      // 评分时间到点触发
    int disturb_mv;           // 0..3 阀编号
    double disturb_delta;     // 开度增量 %
    bool disturb_fired;
    bool disturb_applied;
    double disturb_recover_s;
    double disturb_t0;        // 扰动发生后恢复计时
    bool disturb_recovered;
};

extern ScoreState g_score;

void ScoreInit();
void ScoreColdReset();
void ScoreBeginSession();      // 开始评分：清评分数据并把评分时间归零
void ScoreEndSession();        // 结束评分会话
void ScoreFinishSession();     // 网关异常结束：保留已用时间并封存零分
bool ScoreSessionActive();
double ScoreSessionTime();
bool ScoreSessionFinished();   // 评分限时已到（可查看评分结果）
bool ScoreTakeFinishedEvent(); // 取出“刚结束”事件（返回一次 true，随后自动清）
void ScoreBeginRun(const TankSystem* s);
double ScoreSessionDuration();
void ScoreTick(const TankSystem* s, double dt);
void ScoreSetDisturb(double at_s, int mv, double delta_pct);
void ScoreSetConfig(double dur_unit, double dur_sys, double band_tank, double band_hx, double dist_at, int dist_mv, double dist_delta);
double ScoreBandTailRatio(int pv);
bool ScoreCanSwitch(const TankSystem* s);
void ScoreSetMode(ScoreMode mode);
void ScoreCycleMode();
void ScoreCycleTank();
const wchar_t* ScoreModeText(ScoreMode mode);
const wchar_t* ScoreTankText(int tank);
