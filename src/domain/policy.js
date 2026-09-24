/**
 * 保管链与归并策略。契约副本见 contracts/chain-policy.json。
 */

// 谱系生命周期事件，顺序仅用于文档，强约束在 chain.js 中按资源状态实施。
export const EVENT_TYPES = [
  "collected",
  "aliquoted",
  "handed_over",
  "stored",
  "unsealed",
  "tested",
  "destroyed",
  "seal_revoked",
];

// 交接发出后超过该时长仍未被接收方确认，恢复 sweep 产生超时交接待办。
export const HANDOVER_TIMEOUT_MS = 2 * 60 * 60 * 1000;

// 结论确认后默认关联的观测窗口：采集时刻前后各 N 分钟。
export const OBSERVATION_WINDOW_MS = 30 * 60 * 1000;

/**
 * 敏感物种位置降精度表。角色即项目权限：
 * project_lead 精确坐标；researcher 项目成员约 1km；
 * volunteer 约 10km；public 不给出位置。
 * 坐标为十进制度，保留小数位；同时返回网格精度标签。
 */
export const LOCATION_PRECISION = {
  project_lead: { decimals: 5, grid: "exact", label: "exact" },
  researcher: { decimals: 2, grid: "subgrid", label: "~1km" },
  volunteer: { decimals: 1, grid: "block", label: "~10km" },
  public: { decimals: null, grid: "withheld", label: "withheld" },
};

// 敏感目标（物种 / 检测指标）。非敏感目标对所有角色返回精确位置。
export const SENSITIVE_TARGETS = new Set([
  "SPECIES_SENSITIVE",
  "OTTER",
  "STURGEON",
]);

export const CONCLUSION_CATEGORIES = [
  "consistent",
  "conflict",
  "suspected_contamination",
  "needs_retest",
];
