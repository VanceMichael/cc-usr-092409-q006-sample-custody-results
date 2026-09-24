# 湿地观测记录归并器

服务在归并志愿者、科研样线与固定设备观测的基础上，管理**环境样本保管链（chain of custody）**与**跨实验室结果归并**：同一样本分装送往两家实验室时，系统记录不可覆盖的谱系事件，按规则判定一致、冲突、疑似污染或待复测，并仅在研究员确认后把结论关联到观测窗口。

## 设计要点

- **不可覆盖的谱系**：现场样本（sample）、分装管（tube）、检测批次（batch）的采集、交接、入库、开封、检测、销毁与封签撤销事件只追加。每条记录含发生时间、操作者、温控摘要与内容指纹，落盘为哈希链 JSONL（每条含 `prevHash` 与 `payloadHash`），重放时任一行被篡改即报错。
- **重复扫码幂等**：事件和结果可带 `idempotencyKey`，重复提交返回原始记录，不产生第二条。
- **并发交接确认**：同一封签只允许一个接收方确认成功。第二个确认收到 `409 handover_closed`（基于单进程 CAS，落盘为原子追加）。
- **离线补录裁定**：离线事件若时间越过该资源最后已签节点，不直接生效而进入 `pending`（返回 202）并开立裁定待办；批准后推进状态机，拒绝后标记 `void`。
- **结论规则**：结果保留方法版本、阈值、质控样与不确定度。优先级为 保管链断点 ⇒ `suspected_contamination`；质控失败 / 方法过期 / 不确定度跨阈值 / 仅单家 ⇒ `needs_retest`；阴阳并存 ⇒ `conflict`；否则 `consistent`。
- **确认才发布**：未确认结论不产生观测；研究员确认后才生成观测窗口（采集时刻 ±30 分钟）。
- **版本化**：封签撤销、方法更正、迟到复测只重评未发布草案；已发布结论不被覆盖，而是产生一个替代版草案，确认后替换，旧版留痕。复测会让同一分装管的旧结果退出有效证据集但保留在溯源中。
- **敏感物种降精度**：`OTTER`、`STURGEON` 等敏感目标位置按项目角色返回——project_lead 精确、researcher 约 1km、volunteer 约 10km、public 不给坐标。
- **恢复与待办**：启动即重放哈希链；恢复接口与周期巡查汇总超时交接（发出 2 小时未确认）、待裁定与待复测待办。
- **溯源**：从一条结论可追回所用样本、分装管、批次、全部链事件、保管断点、质控证据、方法版本与批准人。

## 持久化

默认日志写入 `JOURNAL_FILE`（缺省 `data/chain.journal.jsonl`，已在 `.gitignore`）。不传路径时为纯内存模式，便于测试。

## HTTP 接口（v1）

角色通过请求头 `X-Project-Role` 或 `?role=` 传入，用于敏感位置降精度。

### 资源登记
- `POST /v1/samples` — 登记样本，同时写入 `collected` 首事件
- `POST /v1/batches` — 登记实验室检测批次
- `POST /v1/methods` — 登记检测方法（首版本及阈值）
- `POST /v1/methods/corrections` — 方法更正（追加新版本并重评）

### 保管链
- `POST /v1/chain/events` — 追加谱系事件（支持 `idempotencyKey`、`offline`）
  - `aliquoted`：`data.tubes[]` 自动生成管 ID 与内容指纹
  - `handed_over`：`data.stage` 为 `sent` / `confirmed` / `rejected`
- `GET /v1/chain/pending` — 待裁定事件
- `POST /v1/chain/events/{eventId}/adjudications` — `{decision: approved|rejected}`
- `POST /v1/seals/revocations` — 撤销封签
- `GET /v1/samples/{id}`、`GET /v1/tubes/{id}` — 资源与谱系

### 结果与结论
- `POST /v1/results` — 录入结果（方法版本、阈值、qc、uncertainty）
- `POST /v1/retests` — 复测（带 `retestOfResultId`）
- `GET /v1/results/{id}`
- `GET /v1/conclusions/{key}` — 结论各版本（按角色脱敏）
- `POST /v1/conclusions/{key}/evaluations` — 手动重评
- `POST /v1/conclusions/{key}/confirmations` — 研究员确认发布
- `GET /v1/conclusions/{key}/trace` — 全链路溯源
- `GET /v1/observations` — 已发布观测（按角色降精度）

### 待办与恢复
- `GET /v1/todos` — 未关闭待办（超时交接标 `overdue`）
- `GET /v1/recovery` — 重放后恢复汇总

### 事件载荷示例

```json
{
  "resourceKind": "tube",
  "resourceId": "T-1",
  "type": "handed_over",
  "occurredAt": "2026-09-24T08:10:00+08:00",
  "operator": "alice",
  "sealId": "SEAL-A",
  "temperature": { "minC": 3.1, "maxC": 6.4, "excursionCount": 0 },
  "idempotencyKey": "scan-77",
  "data": { "stage": "sent", "to": "LAB-A" }
}
```

## 开发

```bash
npm install
npm test          # node:test 全量测试（保管链 / 结论 / 版本恢复 / 哈希链完整性）
npm run build     # 语法检查
npm start         # 监听 3000 端口，GET /health 返回状态
docker build -t wetland-observation-merger .
```

`contracts/observation-policy.json` 给出来源与归并因素，`contracts/chain-policy.json` 定义保管链事件、判定优先级、版本化与降精度策略。
