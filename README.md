# 三级液位 / 换热器 PID 云仿真（服务器多用户版）

面向大学课堂的多人同时在线版本：学生用“班级码 + 学号 + 姓名”登录，服务器为每个人启动一个
**独立的仿真进程**，回路、参数、曲线、评分互不影响。全体班级由一个总教师账号统一管理，
教师登录后既可以维护班级名单、查看各班的在线状态、曲线和评分记录，也可以直接进入控制 / 仿真、曲线和评分页面进行课堂演示；教师演示会话独立于学生，不会进入学生在线列表或评分记录。

教师看板可按“全部模型 / 三级液位 / 换热器”筛选；在线学生、云端方案和评分记录都带
“模型”列。所有导出文件的名称、CSV 表头和 ZIP 内目录也带模型名：单模型导出标明
“三级液位”或“换热器”，全部模型导出为“全部模型”，并按模型分子文件夹。

- 仿真内核：`C++17`，液位内核 `YunEngine` 与换热器内核 `HxEngine` 分开编译、分开运行；
  PID 共用同一份 `native/pid.cpp`，统一使用 DCS 口径 `Ki = 1 / Ti`
- 网关：`Node.js` 内置模块（无 npm 依赖，Node 18+ 直接跑）
- 前端：原生 `HTML/CSS/JS`，浏览器直接打开，无需构建
- 部署：单台 Linux 服务器 + Docker（阿里云 ECS / 轻量应用服务器均可）

## 文档入口

- 接手第一入口：`docs/交接须知的注意文件.md`
- 文档索引与历史报告说明：`docs/文档索引与阅读顺序.md`
- 当前项目进度：`docs/项目进度.md`
- 部署与 ECS：`docs/部署说明.md`

历史测试报告只用于回溯问题，不代表当前待办；当前能力和约束以交接文件、项目进度和功能手册为准。

## 目录结构

```
YunLevel/
├─ native/              C++ 仿真内核（engine/model/pid/score）
│  └─ build/            Windows 下编译出的 YunEngine.exe
├─ native-hx/           换热器内核（engine/model/score；共用 native/pid.cpp）
│  └─ build/            Windows 下编译出的 HxEngine.exe
├─ bin/                 Linux 下编译出的 YunEngine / HxEngine（镜像内生成）
├─ server/              Node 网关：登录、会话、SSE 推送、教师接口
├─ public/              前端页面
├─ scripts/             内核编译脚本
├─ data/                运行期数据（学生状态、曲线、评分记录）
├─ docs/                部署说明、使用说明、评分说明
├─ Dockerfile
├─ docker-compose.yml
├─ package.json
├─ start-server.bat     Windows 启动
└─ start-server.sh      Linux/macOS 启动
```

## 本地运行（纯本机，不需要任何服务器）

**环境要求**

| 依赖 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | 18 或更高 | 本项目**零 npm 依赖**，不需要执行 `npm install` |
| g++ | 支持 C++17 | 用于编译两个仿真内核 |

Windows 上安装 MinGW-w64 并让 `g++` 进入 PATH；若装在别处，先设置环境变量：

```bat
set MINGW_BIN=<你的MinGW目录>\bin
```

**三步跑起来**

```sh
git clone <你的仓库地址>
cd YunLevel
npm start                 # 首次会自动编译内核，然后打开 http://127.0.0.1:8080
```

`npm start` 的 `prestart` 钩子会检查内核是否存在，缺失时自动编译；也可以手动分开执行：

```sh
npm run build:engine      # 只编译内核（YunEngine + HxEngine）
npm start                 # 启动网关
```

一键脚本：Windows 双击 `start-server.bat`；Linux / macOS 执行 `./start-server.sh`。

**本机没有 g++？** 用 Docker，镜像内会自动编译内核（见下一节）。

> 所有数据都写在本机 `data/` 目录，运行过程不访问任何外部服务或云平台。

## Docker 运行（可选，部署到服务器时用）

```sh
cp .env.example .env          # 先填入你自己的班级码与教师口令
docker compose up -d --build
docker compose logs -f yunlevel
```

> ⚠️ `docker-compose.yml` 里的口令项写的是 `${YUN_TEACHER_CODE:?...}`，
> **没有 `.env` 会直接报错拒绝启动**，不会退回到任何默认口令。
> `.env` 已被 `.gitignore` 排除，不会进入仓库。

镜像构建阶段会在 Linux 内同时编译 `/app/bin/YunEngine` 和 `/app/bin/HxEngine`，
部署后可用以下命令核对：

```sh
docker compose exec yunlevel ls -lh /app/bin
```

打开 `http://服务器IP:8080`。首次启动且 `data/classes.json` 尚不存在时，会自动建立一个空班级。

| 项目 | 默认值 | 环境变量 | 说明 |
| --- | --- | --- | --- |
| 首次默认班级码 | **无默认值，必须自己设置** | `YUN_CLASS_CODE` | 仅用于首次生成空班级，后续可在教师页修改 |
| 总教师口令 | **无默认值，必须自己设置** | `YUN_TEACHER_CODE` | 一个教师账号管理所有班级 |
| 端口 | `8080` | `PORT` | Web 服务端口 |
| 数据目录 | `/app/data` | `YUN_DATA_DIR` | 班级、状态、曲线、评分记录 |
| 换热器内核 | 镜像内 `/app/bin/HxEngine` | `YUN_ENGINE_HX` | 仅需要覆盖默认路径时设置 |
| 最大同时在线 | `120` | `YUN_MAX_SESSIONS` | 所有班级合计 |
| HTTPS Cookie | `0` | `YUN_COOKIE_SECURE` | 当前 HTTP 测试保持 `0` |

上线前请改掉总教师口令。教师登录后可以直接用控制 / 仿真、曲线和评分页做课堂演示，也可以进入“班级管理”新建班级，并通过 Excel、CSV 或手动粘贴导入名单；
学生端只使用对应班级码、学号和姓名登录，不设学生密码。
当前测试阶段不需要域名、HTTPS 或备案，直接访问 `http://服务器公网IP:8080`；
完整步骤见 [docs/部署说明.md](docs/部署说明.md)。

## 数据与备份

运行期数据都在 `data/`（容器里是挂载卷 `/app/data`）：

- `data/classes.json`：班级、班级码和学生名单
- `data/state/<班级+学号哈希>.bin`：仿真状态快照，下次登录自动恢复成**未启动**状态
- `data/history/<班级+学号哈希>.json`：曲线历史（最多 1800 点）
- `data/hx-state/`、`data/hx-history/`：换热器状态与历史，目录与液位完全隔离
- `data/hx-submissions/`、`data/hx-teacher_backups/`：换热器云端方案和教师备份
- `data/score_records.jsonl`：评分记录，教师页面可筛选、导出或清空 CSV

备份只需打包 `data/` 目录；升级镜像不会影响数据。

## 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | 学生/教师登录，成功后写入 HttpOnly Cookie |
| POST | `/api/logout` | 退出并保存状态 |
| GET | `/api/me` | 当前登录身份 |
| GET | `/api/state` | 当前仿真状态（含回路、PID、评分） |
| GET | `/api/history` | 曲线历史 |
| GET | `/api/stream` | 学生 / 教师演示 SSE 通道，推送逐秒状态 |
| POST | `/api/command` | 控制命令（启动/暂停/回路/PID/评分等） |
| GET | `/api/score-record` | 自己最近一条评分记录（用于显示评分结束时间） |
| GET | `/api/health` | 健康检查（容器与反向代理探活） |
| GET | `/api/teacher/overview` | 教师看板：在线学生汇总 |
| GET | `/api/teacher/stream` | 教师 SSE 通道（最多每秒推送一次） |
| GET | `/api/teacher/student/:classId/:studentId` | 指定班级学生的详情与曲线 |
| GET | `/api/teacher/records` | 评分记录列表 |
| GET | `/api/teacher/export.csv` | 导出评分记录 CSV |
| POST | `/api/teacher/cloud-export` | 按班级、学生批量导出已上传云端方案 1 的参数和三张曲线 PNG |
| GET/POST | `/api/teacher/classes` | 查询或新建班级 |
| PUT/DELETE | `/api/teacher/classes/:id` | 修改或删除班级 |
| GET/POST | `/api/teacher/classes/:id/students` | 查询或添加学生 |
| PUT/DELETE | `/api/teacher/classes/:id/students/:studentId` | 修改或删除学生 |
| POST | `/api/teacher/classes/:id/import` | 合并或覆盖导入名单 |
| GET | `/api/teacher/classes/:id/export.csv` | 导出班级名单 CSV |
| POST | `/api/teacher/clear` | 清空评分记录 |

教师看板、提交列表、项目列表、评分记录和云端导出接口均接受
`?model=all|tank|hx`。`model=all` 会同时返回两个模型并保留每行自己的 `modelId`；
读取学生方案时可在请求体中显式传 `model`，教师仿真会切到对应内核。

## 并发与资源

- 每位学生一个 C++ 进程，空闲进程内存约 10 MB，运行中约 15 MB；120 人在线大致占用 1.5～2 GB 内存。
- 服务器按 1 秒一拍推进仿真，每拍把一份完整状态推给该学生（约 2～3 KB）；100 人在线时出口带宽约 300 KB/s，
  建议至少 5 Mbps 公网带宽。
- 单台 2 核 4G 的 ECS / 轻量应用服务器可支撑一个班（40～60 人）同时运行；
  如果同时在线人数长期超过 120，请把 `YUN_MAX_SESSIONS` 调大并相应增加内存，或多开一台服务器分流。

## 安全提醒

- 目前是课堂内网/公网直连的轻量方案：只有班级码和教师口令两道口令，没有个人密码。
  如果要长期开放到公网，建议加 HTTPS（见部署说明）并定期更换口令。
- 学生只能看到自己的数据；教师接口全部经过口令校验。
- 分数只由服务器上的 C++ 内核计算，浏览器只能发送命令，不能改分。

## 与桌面版的关系

桌面版 `TankLevelPID.exe`（Rev8）保持独立、不受影响。云版复用同一套仿真与评分内核，
界面按"多用户 + 浏览器"重新实现，功能对齐：控制区、独立仿真画面、液位/流量/开度曲线、
PID 计算过程、单罐/系统评分、评分结束时间、教师看板与记录导出。

换热器模型通过登录页的“实验模型”选择进入。学生端是否显示该选项由教师在云端数据区
的“换热器模型：关闭/开放”开关控制；教师端始终可以直接进入。换热器推荐工况使用
`TI1104 → FV1102` 单回路，串级仍可自由搭建。

后续如需把网关替换为 ASP.NET Core（C#）或 Go，只需重写 `server/` 这一层，
`native/` 内核与 `public/` 前端可以原样保留。

## 许可证

本项目以 **GNU GPL-3.0**（或更新版本）发布，版权归 **南宁职业技术大学215工作室** 所有。

- 完整条款：[LICENSE](LICENSE)
- 版权声明：[COPYRIGHT](COPYRIGHT)
- 第三方组件声明：[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)

你可以自由使用、修改、再分发本项目，**但衍生作品必须以同样的 GPL 条款开源**，不能闭源独吞。

> 注意：GPL-3.0 **不约束「把程序部署成网络服务供他人使用」这一情形**（那需要 AGPL-3.0）。
> 若日后要补上这条约束，可整体换成 AGPL-3.0。
