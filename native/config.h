#pragma once
#include "pipe.h"

// ---- Layout (aligned with Test5-1.1 BoilerPID) ----
constexpr int    BASE_W = 1366;
constexpr int    BASE_H = 780;
constexpr int    MAX_POINTS = 3600;
constexpr int    TIMER_ID = 1;
constexpr int    TIMER_INTERVAL = 1000;

// Views: 0=曲线, 1=仿真图, 2=控制区 (same order as BoilerPID)
// Views: 0=曲线, 1=仿真图, 2=控制区, 3=PID 计算过程（只显示已搭建的回路）
enum View { VIEW_CURVE = 0, VIEW_SIM = 1, VIEW_CONTROL = 2, VIEW_PID = 3, VIEW_SCORE = 4, VIEW_COUNT = 5 };

// ---- 用户自搭回路（单回路方案）----
constexpr int MAX_LOOPS = 4;      // 最多同时搭建 4 个回路
constexpr int N_PV = 3;           // LI101 / LI102 / LI103
constexpr int N_MV = 4;           // FV101 / FV102 / FV103 / FV104
constexpr int N_PVX = 6;          // 0..2=液位 LI101..103 | 3..5=流量 FI101..103
constexpr int MAX_CASC = 2;       // 串级方案：最多同时搭建 2 条串级（阀门+主环+副环）

// ---- Control IDs ----
// 单回路方案：用户自搭液位回路卡（SP/Kp/Ti/Td + 手自动 + 手动输出 MV）
// 串级方案：阀门 + 主环 + 副环自由搭建，同页也可搭单回路
constexpr int IDC_EDIT_PUMP    = 231;  // P101  给水泵   %（只能手动）
constexpr int IDC_EDIT_FV104   = 232;  // FV104 出口阀 %（手操）
constexpr int IDC_EDIT_YMAX    = 233;  // 液位曲线 Y 轴上限 %FS
constexpr int IDC_EDIT_FLOWYMAX= 234;  // 流量曲线 Y 轴上限 L/min（上限 = 阀门参考最大值）
constexpr int IDC_EDIT_MSTOUT  = 236;  // 串级：主控罐出口阀手操 %（仅 B 方案且主控罐≠T3 时出现）

constexpr int IDC_BTN_START    = 240;  // 启动（初始一切静止，点击后才开始运算）
constexpr int IDC_BTN_PAUSE    = 241;
constexpr int IDC_BTN_RESET    = 242;
constexpr int IDC_BTN_APPLY    = 243;
constexpr int IDC_BTN_PRESET   = 244;
constexpr int IDC_BTN_PIDDATA  = 245;  // PID 计算过程面板开关（默认关）
constexpr int IDC_BTN_SCORESTART = 246;  // 开始评分（冷态下清空回路卡并从 0 开始计时）
constexpr int IDC_BTN_ANN      = 247;
constexpr int IDC_BTN_FULL     = 248;
constexpr int IDC_BTN_BIAS     = 249;  // PID 前馈偏置开关（开/关）
constexpr int IDC_BTN_PIDSIM   = 254;  // 仿真图右上角：PID 计算过程面板开关
constexpr int IDC_BTN_SCOREMODE = 250;  // 评分模式：关 / 单罐 / 系统
constexpr int IDC_BTN_SCORETANK = 251;  // 单罐评分对象：LI101 / LI102 / LI103
constexpr int IDC_BTN_SCOREEXPORT = 252; // 评分结果页：导出记录 CSV
constexpr int IDC_BTN_SCORECLEAR  = 253; // 评分结果页：清空记录
// ---- 用户自搭回路（单回路）：回路卡输入框 300..319，手操框 331..334，按钮 350..366
// 回路 i 的 5 个字段：0=设定SP(%FS) 1=Kp 2=Ti(s) 3=Td(s) 4=手动输出MV(%)
constexpr int IDC_LOOP_EDIT_BASE = 300;
inline int LoopEditId(int i, int f) { return IDC_LOOP_EDIT_BASE + i * 5 + f; }
// 手操：FV101/FV102/FV103/FV104（P101 仍用 IDC_EDIT_PUMP）
constexpr int IDC_EDIT_VALVE_BASE = 331;
inline int ValveEditId(int v) { return IDC_EDIT_VALVE_BASE + v; }
// 回路卡按钮：手/自动、正/反作用、删除
constexpr int IDC_BTN_LOOPAUTO_BASE = 350;
constexpr int IDC_BTN_LOOPACT_BASE  = 354;
constexpr int IDC_BTN_LOOPDEL_BASE  = 358;
// 搭建面板
constexpr int IDC_BTN_BUILD      = 362;  // 搭建回路（展开/收起搭建面板）
constexpr int IDC_BTN_REC        = 363;  // 推荐回路（一键填入推荐三只）
constexpr int IDC_BTN_CLR        = 364;  // 清空回路
constexpr int IDC_CMB_PV         = 365;  // 搭建面板：被控量（液位）下拉
constexpr int IDC_CMB_MV         = 366;  // 搭建面板：操纵量（阀）下拉
constexpr int IDC_BTN_ADD        = 367;  // 搭建面板：确认搭建（把模板里的两个位号合成回路卡）
constexpr int IDC_CMB_TYPE       = 368;  // 搭建面板：类型下拉（串级 / 单回路）
constexpr int IDC_CMB_SEC        = 369;  // 搭建面板：副环下拉（串级）
// 串级卡：每条串级 8 个输入框（主环 SP/Kp/Ti/Td + 副环 SP/Kp/Ti/Td）
constexpr int IDC_CASC_EDIT_BASE = 420;
inline int CascEditId(int i, int f) { return IDC_CASC_EDIT_BASE + i * 8 + f; }
// 串级卡按钮：主环手/自动、主环正/反作用、删除
constexpr int IDC_BTN_CASCAUTO_BASE = 440;
constexpr int IDC_BTN_CASCACT_BASE  = 442;
constexpr int IDC_BTN_CASCDEL_BASE  = 444;
constexpr int IDC_DROP_ITEM     = 400;  // 搭建面板：下拉浮层里的列表项（具体第几项用 HitDropItem 取）

// Alarms (mm)
constexpr double ALARM_HI_MM  = 900.0;
constexpr double ALARM_LO_MM  = 50.0;
constexpr double ALARM_OVF_MM = 1000.0;

enum CurveGroup { CURVE_LEVEL = 0, CURVE_FLOW = 1, CURVE_OPEN = 2, CURVE_GROUP_COUNT = 3 };
enum LoopMode { MODE_A = 0, MODE_B = 1 };

// ---- Units (M1) ----
constexpr double MM2M     = 0.001;
constexpr double M2MM     = 1000.0;
constexpr double LMIN2M3S = 1.0 / 60000.0;
constexpr double M3S2LMIN = 60000.0;
constexpr double PI_C     = 3.14159265358979323846;

constexpr double TANK_D_MM   = 150.0;
constexpr double TANK_H_MM   = 1000.0;
constexpr double OUT_D_MM    = 10.0;
constexpr double CD_ORIFICE  = 0.61;
constexpr double G_MPS2      = 9.81;
// Fixed teaching geometry: FV102 (T1 -> top of T2), FV103 (T2 -> top of T3),
// FV104 (T3 -> atmospheric drain). Container dimensions remain unchanged.
// Length/diameter/roughness determine Darcy-Weisbach friction; minor_loss is
// additional fixed fitting resistance. The original Cd defines valve loss.
constexpr GravityPipe GRAVITY_PIPES[3] = {
    {2.0, OUT_D_MM * MM2M, 1.5e-6, 1.5, 1.0 / (CD_ORIFICE * CD_ORIFICE)},
    {3.0, OUT_D_MM * MM2M, 1.5e-6, 1.5, 1.0 / (CD_ORIFICE * CD_ORIFICE)},
    {4.0, OUT_D_MM * MM2M, 1.5e-6, 1.5, 1.0 / (CD_ORIFICE * CD_ORIFICE)},
};
constexpr double L_MAX_MM    = 1000.0;
constexpr double L_MIN_MM    = 0.0;

constexpr double Q_PUMP_MAX_LMIN = 20.0;
constexpr double T_PUMP_S        = 2.0;
// 阀门公称通流参考值。实际流量仍由上游压头决定：FV101 受泵（20 L/min）驱动，
// FV102/103/104 受罐体水头及各段管道阻力驱动，因此相同流量下开度不必相同。
constexpr double Q_VALVE_MAX_LMIN= 15.0;
constexpr double T_STROKE_S      = 30.0;
constexpr double VALVE_RATE_PCT_S= 100.0 / 30.0;

constexpr double TAU_SENSOR_S    = 2.0;
constexpr double NOISE_PCT_FS    = 0.5;
constexpr double NOISE_TAU_S     = 3.0;   // 测量噪声相关时间，避免逐点白噪声式跳变

constexpr double DT_MAIN_S       = 1.0;
constexpr double DT_SUB_S        = 0.1;
constexpr int    SUBSTEPS        = 10;

// ---- 评分会话限时 ----
// 点「开始评分」后，评分时间走到该值即自动结束（运行中不显示该值，
// 只在结束后的评分结果画面显示）。单位：秒。
constexpr double SCORE_DURATION_S = 1500.0;   // 系统 25 分钟（默认/上限）
constexpr double SCORE_DURATION_UNIT = 480.0;  // 单对象 8 分钟
constexpr double SCORE_DURATION_SYSTEM = 1500.0;
constexpr double SCORE_BAND_TAIL_RATIO = 0.35; // 目标范围自结束向前回推窗口

// ---- 泵特性（PI101 泵出口压力用，简化理想特性）----
// H = H0*n^2 - k*q^2,  H0=3.0 m, k = 0.5*H0/Qmax^2
constexpr double H_PUMP_SHUTOFF_M = 3.0;
constexpr double PUMP_HEAD_K      = 0.5 * H_PUMP_SHUTOFF_M /
                                    (Q_PUMP_MAX_LMIN * LMIN2M3S * Q_PUMP_MAX_LMIN * LMIN2M3S);
