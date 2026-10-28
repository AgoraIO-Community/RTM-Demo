/**
 * 场景注册表：8 个一级分类 + 23 个二级场景。
 *
 * 每个条目**只有 `id` / `title` / `summary` / `status` 四个字段**，这是一道刻意的护栏。
 * 描述画布形态、角色清单、可执行动作之类的字段一律不放进来 —— 那种设计服务于
 * 「一套通用 UI 数据驱动渲染所有场景」，与本项目「一场景一份 RTM 单文件 + 独立主容器」
 * 的架构正面冲突（见 spec「场景注册表」的丢弃字段表）。
 *
 * 能力标签不进注册表，住在同目录的 `capabilities.ts`。
 */

/** 场景状态只有两个值。刻意不引入「进行中」—— 它是过程状态，会诱使人把半成品合进主干。 */
export type SceneStatus = "ready" | "planned";

export interface SceneEntry {
  /**
   * kebab-case，**不带一级分类前缀**。
   * id 出现在 URL 里应当稳定，前缀会在场景归类调整时造成 id 变更。
   */
  id: string;
  title: string;
  /** 一句话摘要。 */
  summary: string;
  status: SceneStatus;
}

export interface SceneCategory {
  id: string;
  /** 完整分类名，用于一级 tab 条。 */
  label: string;
  /** 窄屏用的短标签（票 01 要求保留）。不长于 `label`。 */
  shortLabel: string;
  scenes: SceneEntry[];
}

/** 已规划场景的字面量收窄到一处，避免 23 行里 22 行重复写 `status: 'planned'`。 */
function planned(id: string, title: string, summary: string): SceneEntry {
  return { id, title, summary, status: "planned" };
}

export const sceneCategories: SceneCategory[] = [
  {
    id: "social",
    label: "社交 / 娱乐",
    shortLabel: "社交",
    scenes: [
      planned(
        "presence",
        "在线、好友与忙闲状态",
        "让好友、主播和关注者实时看到可信的在线与忙闲变化。",
      ),
      planned(
        "im-chat",
        "私聊、群聊与消息回执",
        "用统一的消息链路完成私聊、群聊和轻量回执。",
      ),
      {
        id: "voice-room",
        title: "语聊房：麦位与房内互动",
        summary:
          "通过请求、审批、共享快照和麦位锁保持麦位一致，并承载弹幕、礼物与表情。",
        status: "ready",
      },
      planned(
        "live-pk",
        "连麦、PK 与房间互动",
        "同步主播邀请、PK 回合、比分和结束状态。",
      ),
      {
        id: "one-to-one-call",
        title: "呼叫、接听与挂断",
        summary: "在媒体建立前后同步邀请、振铃和通话生命周期。",
        status: "ready",
      },
      planned(
        "room-moderation",
        "禁言、踢人、举报与封禁",
        "让管理动作实时生效，并用共享状态保持治理结果一致。",
      ),
    ],
  },
  {
    id: "education",
    label: "在线教育",
    shortLabel: "教育",
    scenes: [
      planned(
        "classroom-messaging",
        "课堂 IM 与班级通知",
        "把课堂提问、助教答疑和班级通知放在同一实时链路中。",
      ),
      planned(
        "classroom-stage",
        "举手、上下麦与连麦",
        "用实时审批和发言权状态完成课堂会控。",
      ),
      planned(
        "classroom-quiz",
        "答题、抢答、投票与签到",
        "实时下发互动任务并快速汇总结果。",
      ),
      planned(
        "learning-device",
        "设备在线与远程指令",
        "同步学习终端在线状态并安全地下发管理指令。",
      ),
    ],
  },
  {
    id: "enterprise",
    label: "企业服务 / 垂直行业",
    shortLabel: "企业",
    scenes: [
      planned(
        "team-collaboration",
        "单聊、群聊与组织消息",
        "承载协作消息、组织通知和文件流转状态。",
      ),
      planned(
        "field-operations",
        "设备状态、告警与调度",
        "把现场告警、人员状态和任务调度连接成处置闭环。",
      ),
      planned(
        "video-meeting",
        "入会、举手、共享与会控",
        "在音视频之外同步邀请、成员、共享和会议控制状态。",
      ),
    ],
  },
  {
    id: "iot",
    label: "IoT / 智能硬件",
    shortLabel: "物联网",
    scenes: [
      planned(
        "device-telemetry",
        "在线状态与遥测上报",
        "持续同步设备在线、电量、温度和位置等轻量状态。",
      ),
      planned(
        "device-control",
        "远程指令、任务与配置下发",
        "用定向命令和双阶段 ACK 建立设备控制闭环。",
      ),
      planned(
        "security-alerts",
        "告警事件实时推送",
        "把传感告警实时分发给多个处置端并同步处理结果。",
      ),
    ],
  },
  {
    id: "content",
    label: "内容 / 直播",
    shortLabel: "内容",
    scenes: [
      planned(
        "live-chat-gifts",
        "弹幕、公屏与礼物",
        "对高频弹幕、点赞和礼物事件采用适合的广播策略。",
      ),
      planned(
        "live-operations",
        "开播、进出房与主播状态",
        "同步开关播、观众进出和主播忙闲状态。",
      ),
      planned(
        "live-guests",
        "连麦、上下麦与嘉宾控制",
        "同步嘉宾邀请、席位和发言权变化。",
      ),
    ],
  },
  {
    id: "healthcare",
    label: "医疗健康",
    shortLabel: "医疗",
    scenes: [
      planned(
        "telemedicine-call",
        "在线问诊呼叫与通话状态",
        "在医患会话中同步邀请、振铃、接听和结束状态。",
      ),
    ],
  },
  {
    id: "mobility",
    label: "出行 / 本地生活",
    shortLabel: "出行",
    scenes: [
      planned(
        "dispatch-order",
        "派单与订单状态",
        "实时下发调度任务并同步履约阶段。",
      ),
      planned(
        "driver-rider-messaging",
        "司机、骑手与乘客通信",
        "通过匿名业务身份完成隐私呼叫和订单内消息。",
      ),
    ],
  },
  {
    id: "gaming",
    label: "游戏",
    shortLabel: "游戏",
    scenes: [
      planned(
        "game-voice-chat",
        "游戏语音房与聊天",
        "同步队友在线、房间成员、麦位和轻量聊天。",
      ),
    ],
  },
];

/** 各分类场景的扁平展开，顺序与分类顺序一致。 */
export const allScenes: SceneEntry[] = sceneCategories.flatMap(
  (category) => category.scenes,
);

export function findCategory(categoryId: string): SceneCategory | undefined {
  return sceneCategories.find((category) => category.id === categoryId);
}

export function findScene(sceneId: string): SceneEntry | undefined {
  return allScenes.find((scene) => scene.id === sceneId);
}
