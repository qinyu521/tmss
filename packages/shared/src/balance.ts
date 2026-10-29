/**
 * 数值平衡配置 —— 所有资源、军需与战斗系数集中于此，方便调参。
 * 说明：单位约定 粮=石，盐/铁=担，战马=匹，银钱=两，兵员=人，人口=人。
 */
export const BALANCE = {
  turnDays: 7,
  /** 每千人每周粮耗（石） */
  grainPerThousandPerWeek: 120,
  /** 每千人每周盐耗（担） */
  saltPerThousandPerWeek: 1.5,
  /** 每千人每周铁耗（担，军械维护） */
  ironPerThousandPerWeek: 0.8,
  /** 每千骑兵每周战马补充/损耗（匹） */
  horsePerThousandCavalry: 2.4,
  /** 每名士兵每周军饷（两） */
  cashPerSoldierPerWeek: 0.06,
  /** 每名新兵招募成本（两、粮、铁、盐） */
  recruit: {
    cashPerMan: 2,
    grainPerMan: 0.2,
    ironPerMan: 0.002,
    saltPerMan: 0.01,
    horsesPerMan: 0.0008,
    manpowerPerMan: 1,
  },
  /** 贸易基准价（每单位资源） */
  prices: {
    grain: 8,
    salt: 42,
    iron: 34,
    horses: 950,
  },
  /** 贸易溢价：边市并非总是划算 */
  tradePremium: 1.15,
  /** 加征商税：每点治安/支持度的代价换取的银钱 */
  levyTax: {
    cashPerRegion: 9_000,
    orderCost: 4,
    supportCost: 4,
    maxPerTurn: 3,
  },
  /** 征粮：从州仓提取粮，伤民 */
  levyGrain: {
    grainPerRegion: 9_000,
    orderCost: 5,
    supportCost: 2,
    maxPerTurn: 3,
  },
  /** 赏赐/协商成本与收益 */
  appeaseTribe: { cashPerPoint: 900, loyaltyPerPoint: 0.6, maxPerTurn: 2 },
  balancePrinces: { cashCost: 18_000, stabilityGain: 7, topInfluenceDrop: 6 },
  negotiateHouse: { cashCost: 12_000, supportGain: 8, taxGain: 3 },

  /** 军队基础 */
  army: {
    baseMorale: 62,
    baseTraining: 55,
    maxSupply: 100,
    /** 道路成本抽象单位换算为行军日：基础成本每单位约 2.5 天，再按机动与季节修正。 */
    movementCostDayScale: 2.5,
    marchSupplyDrainPerDay: 1.4,
    restSupplyGainPerDay: 4.5,
    restMoraleGain: 4,
    fatigueMarchPerDay: 2.1,
    fatigueRecoverPerDay: 4.0,
    attritionSupplyBelow: 30,
    attritionRatePerDay: 0.0015,
  },

  /** 战斗系数 */
  battle: {
    unitBaseWeight: 1,
    moraleFactor: 0.65,
    trainingFactor: 0.55,
    supplyFactor: 0.85,
    commandFactor: 0.6,
    fatigueFactor: 1.1,
    fortificationFactor: 0.55,
    garrisonQuality: 0.45,
    randomSpread: 0.12,
    winnerLossRate: 0.06,
    loserLossRate: 0.18,
    maxLossRate: 0.42,
  },

  /** 经济与补给 */
  economy: {
    taxComplianceFloor: 0.45,
    unrestTaxPenalty: 0.7,
    grainShortageMorale: 9,
    grainShortageDesertion: 0.018,
    saltShortageMorale: 5,
    saltShortageRecovery: 0.6,
    ironShortageEquipment: 0.8,
    horseShortageMobility: 0.85,
    supplyShortageBattlePenalty: 0.8,
    manpowerRegenRate: 0.012,
    horsesPerCavalryRatio: { HUN: 0.52, YONG: 0.16, CHU: 0.11 } as Record<string, number>,
  },

  /** 政治系统 */
  politics: {
    hun: {
      baseCohesion: 58,
      cohesionDrift: -0.6,
      loyaltyDecay: 0.5,
      refusalThreshold: 42,
      giftLoyaltyGain: 9,
      mobilizableFloor: 0.45,
      mobilizableCeiling: 0.95,
    },
    yong: {
      baseCourtStability: 62,
      princeInfluenceDrift: 1.1,
      crisisThreshold: 34,
      stabilityRecovery: 1.2,
      maxInfluence: 100,
      crisisAdminPenalty: 0.72,
      crisisRecruitPenalty: 0.7,
    },
    chu: {
      baseCentralAuthority: 56,
      houseSupportBase: 52,
      boycottThreshold: 38,
      taxComplianceScale: 0.58,
      privateForcePerSupport: 120,
      negotiationCooldown: 2,
    },
  },

  /** 人物生命周期：衰老/死亡/继承/成长（engine/lifecycle.ts） */
  lifecycle: {
    /**
     * 每旬基础死亡概率，按种子 age_band 词表映射。
     * 种子词表仅四段（青年/壮年/中年/老成），「老成」为最高龄档，采用老年档 1.5%；
     * 暮年 4% 保留给未来更高龄档扩展。
     */
    mortalityPerTurn: { 青年: 0.001, 壮年: 0.002, 中年: 0.005, 老成: 0.015 } as Record<string, number>,
    /** 词表外年龄段缺省概率 */
    defaultMortality: 0.002,
    /** 本旬参战部队主将的额外战死概率 */
    battleDeathBonus: 0.015,
    /** 主将阵亡后部队士气惩罚 */
    armyMoraleLossOnCommanderDeath: 8,
    /** 部落首领身故的忠诚震荡 */
    tribeLoyaltyLossOnChiefDeath: 12,
    /** 世家家主身故的支持度震荡 */
    houseSupportLossOnPatriarchDeath: 6,
    /** 皇子身故对朝局稳定的冲击 */
    courtStabilityLossOnPrinceDeath: 10,
    /** 成长：潜力门槛 / 间隔回合（约一年 52 旬） / 属性上限 */
    growthMinPotential: 70,
    growthIntervalTurns: 52,
    growthCap: 95,
  },

  /** 季节修正（由 engine/season.ts 读取）——均为温和修正项，不颠覆基础玩法 */
  seasons: {
    /** 春：青黄不接，粮产略减；农闲入伍，兵员恢复加快 */
    spring: { foodOutput: 0.9, saltOutput: 1, manpowerRegen: 1.2, marchFatigue: 1, hunMarchFatigue: 1 },
    /** 夏：晒盐旺季；暑热使行军疲劳加剧，匈奴骑兵尤其不耐暑 */
    summer: { foodOutput: 1, saltOutput: 1.2, manpowerRegen: 1, marchFatigue: 1.2, hunMarchFatigue: 1.15 },
    /** 秋：秋收在野，秋高马肥 */
    autumn: { foodOutput: 1.6, saltOutput: 1, manpowerRegen: 1.3, marchFatigue: 1, hunMarchFatigue: 1 },
    /**
     * 冬：粮产锐减；匈奴远征草料难继（粮耗增加）；
     * 河网封冻：骑军可涉渡（行军成本下降），水战与漕运税收受限
     */
    winter: {
      foodOutput: 0.35,
      saltOutput: 1,
      manpowerRegen: 1,
      marchFatigue: 1,
      hunMarchFatigue: 1,
      hunGrainUse: 1.25,
      riverTax: 0.9,
      hunCavalryRiverCost: 0.8,
      navalRaiderRiverPower: 0.8,
      riverCavalryPower: 1.1,
    },
  },

  /** 匈奴远征惩罚：距离首都越远，粮耗越高 */
  hunExpedition: {
    distanceGrainPenaltyPerHop: 0.06,
    maxPenalty: 0.45,
  },

  /** 每年/每回合稳定度漂移 */
  drift: {
    orderRecovery: 0.4,
    loyaltyRecovery: 0.3,
    threatDecay: 1.2,
    reputationDecay: 0.1,
  },

  /** 初始外交关系（-100 敌对 ~ 100 同盟） */
  initialDiplomacy: {
    'HUN|YONG': -46,
    'HUN|CHU': -8,
    'YONG|CHU': -32,
  } as Record<string, number>,

  warThreshold: -25,
} as const;

/** 初始库存（按国情刻意制造短缺：匈奴缺粮盐铁、大雍缺盐马、大楚缺马铁） */
export const INITIAL_RESOURCES: Record<string, { grain: number; salt: number; iron: number; horses: number; cash: number; manpower: number }> = {
  HUN: { grain: 78_000, salt: 820, iron: 740, horses: 26_400, cash: 118_000, manpower: 92_000 },
  YONG: { grain: 486_000, salt: 3_050, iron: 12_800, horses: 2_600, cash: 884_000, manpower: 268_000 },
  CHU: { grain: 268_000, salt: 14_600, iron: 520, horses: 900, cash: 712_000, manpower: 148_000 },
};
