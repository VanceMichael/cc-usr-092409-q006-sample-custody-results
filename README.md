# 湿地观测记录归并器（环境样本保管链与结果归并服务）

服务在归并志愿者、科研样线与固定设备的鸟类观测之外，新增**环境样本保管链**能力：把同一份环境水样分装送往多家实验室时，为现场样本、分装管和检测批次建立**不可覆盖的谱系**，记录采集、交接、入库、开封、检测、销毁全过程；实验室结果按统一规则形成结论，研究员确认后才并入观测窗口；敏感物种位置按项目权限降精度。

## 设计要点

- **仅追加事件溯源**：所有写操作追加到 `data/chain.jsonl`。每个实体（样本/分装管/批次/结果/结论/窗口）维护一条 SHA-256 哈希链，事件含 `prev_hash`；事件载荷另算内容指纹 `content_digest`。状态由重放投影得到，永不就地覆盖。重放时逐行校验，篡改或缺行直接拒绝启动（`chain_integrity`）。
- **谱系事件六要素**：每个事件记录发生时间（`occurred_at`，离线可补报）、落盘时间（`recorded_at`）、操作者（`operator`）、温控摘要（`temp`）、内容指纹与链哈希。
- **幂等与并发**：
  - `Idempotency-Key`（请求级）与 `scan_nonce`（扫码事务号）双重去重：重复扫码/重试只返回原事件；
  - 同一封签被两个接收方并发确认时，同步追加 + 状态检查保证先到者落盘、后到者收到 `409 seal_already_confirmed`。
- **离线裁定**：`offline=true` 且发生时间早于该实体最后在线已签节点的事件标记 `out_of_order`，进入待裁定；审核 `accept` 解除、`reject` 记为保管断点。待裁定期间结论只能是 `needs_retest`。
- **结果归并**：结果必须保留方法标识与版本、阈值、质控样、测量不确定度。系统按规则生成四类结论：
  - `consistent`（一致：定性同向，或数值差在合成扩展不确定度内）
  - `conflict`（冲突：一阳一阴，或数值差超出合成不确定度）
  - `suspected_contamination`（疑似污染：空白/阴性对照检出，或封签接收时破损）
  - `needs_retest`（待复测：冷链中断、超时交接、封签撤销、离线事件驳回、非污染性质控失败、落在不确定度带内、待裁定中）
- **发布闸门与版本**：结论只有 `proposed`，研究员显式确认（必须指定观测窗口）后才 `confirmed` 并关联窗口。封签撤销、方法更正、迟到复测只重评**未发布**结论（判定未变不升版本）；已发布结论不可改，产生 `superseded` 替代版，重新走确认。
- **复测取代**：迟到复测（`retest_of`）到达后，原结果不再参与判定但保留在谱系中。
- **位置降精度**：敏感物种按项目策略与查询者角色输出 `exact | grid(0.05°) | region(0.5°) | withhold`；无项目权限者默认隐去坐标，原始坐标不出服务边界。
- **崩溃恢复**：启动时重放日志并立即巡检；`tick` 把超时交接补办为 `HANDOVER_OVERDUE`、超期复测补办为 `CONCLUSION_RETEST_OVERDUE`，补办幂等；`/v1/todos` 列出待继续的交接与复测。
- **追溯**：`GET /v1/conclusions/{id}/trace` 从一条结论追回所用样本、分装管谱系、保管断点、质控证据和批准人（含历史版本链）。

## HTTP 接口（v1）

所有状态变更建议携带 `Idempotency-Key` 头；操作者可放在 `X-Actor` 头或各接口的操作者字段。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/projects/{projectId}/policy` | 配置敏感物种、成员角色与降精度等级 |
| POST | `/v1/samples` | 采集现场样本（site、matrix、temp、offline、scan_nonce） |
| GET | `/v1/samples/{id}` | 样本状态 |
| POST | `/v1/samples/{id}/destroy` | 销毁样本 |
| POST | `/v1/samples/{id}/aliquots` | 制备分装管（必填 seal_id、tube_barcode） |
| GET | `/v1/aliquots/{id}` | 分装管谱系事件 |
| POST | `/v1/aliquots/{id}/handovers` | 发起交接（seal_id、expected_receiver） |
| POST | `/v1/handovers/{id}/accept` | 接收方扫码确认封签（seal_intact、temp、offline） |
| POST | `/v1/aliquots/{id}/store` | 入库 |
| POST | `/v1/aliquots/{id}/open` | 开封 |
| POST | `/v1/aliquots/{id}/revoke-seal` | 撤销封签 |
| POST | `/v1/aliquots/{id}/adjudications` | 裁定离线事件（verdict=accept/reject） |
| POST | `/v1/aliquots/{id}/destroy` | 销毁分装管 |
| POST | `/v1/batches` | 登记检测批次 |
| POST | `/v1/batches/{id}/results` | 录入结果（method.version、threshold、uncertainty、qc、retest_of） |
| POST | `/v1/results/{id}/corrections` | 方法/阈值/质控更正 |
| POST | `/v1/samples/{id}/conclusions/{analyte}/evaluate` | 主动触发重评 |
| POST | `/v1/conclusions/{id}/confirm` | 研究员确认并关联观测窗口 |
| GET | `/v1/conclusions/{id}` | 当前结论 |
| GET | `/v1/conclusions/{id}/trace` | 完整追溯 |
| POST | `/v1/windows` | 登记观测窗口 |
| GET | `/v1/windows?project_id=&actor=` | 按权限降精度查询窗口及已发布关联 |
| GET | `/v1/todos` | 超时交接与待复测待办 |
| POST | `/v1/tick` | 手动巡检（body.at 可指定时刻） |
| GET | `/health` | 健康状态与日志序号 |

契约文件：`contracts/observation-policy.json`（归并规则）、`contracts/custody-chain.json`（事件与完整性）、`contracts/location-precision.json`（降精度）。

## 运行与验证

```bash
npm install
npm test          # 27 个测试：领域规则 + HTTP 端到端（含并发确认、幂等）
npm run build     # 全部源文件语法检查
npm start         # 默认 3000 端口，事件日志在 ./data，DATA_DIR 可覆盖
docker build -t wetland-observation-merger .
```

关键环境变量：`PORT`、`DATA_DIR`、`SCAN_INTERVAL_MS`（定时巡检，默认 60000；设 0 关闭）。

## 存储与运维边界

- 事件日志为单文件 JSONL，同步追加；生产部署如需多实例水平扩展，应把追加层替换为带条件写入的事务存储，本服务的并发唯一确认依赖单写者的串行追加。
- `data/` 已被 git 忽略。日志文件被改动或删除行会在下次启动时被完整性校验发现并拒绝服务。
