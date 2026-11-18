import { Claim, Evidence } from './types';

export interface InputGuardResult {
  blocked: boolean;
  flags: string[];
  effectiveGoal: string;
  /** 去掉违规诉求后的纯净目标，用于实体/意图解析（不含改写说明文字） */
  parseGoal: string;
  message?: string;
}

const PREDICT = /(明天|明日|下周|下个月|未来|接下来|后市|年底|短期内?).{0,8}(涨|跌|走势|能到|会到|点位)|会不会(涨|跌)|能涨到|涨到多少|跌到多少|目标价|预测.{0,4}(股价|涨跌|点位|走势)/;
const ADVICE = /(该不该|应该|要不要|能不能|能|可以|建议|推荐|值不值得).{0,4}(买|卖|加仓|减仓|清仓|抄底|上车|梭哈)|买入还是卖出|买点|卖点|荐股|推荐.{0,8}(股票|个股|标的)|买哪(个|只)/;
const GUARANTEE = /稳赚|保本|保证.{0,4}收益|收益承诺|翻倍|无风险|必涨|包赚/;
const ILLEGAL = /内幕(消息|信息)|操纵(股价|市场)|拉抬股价|老鼠仓|坐庄|对倒/;

/** 输入侧合规：识别预测/荐股/收益承诺诉求，改写为可验证的研究任务；违法诉求直接拒绝 */
export function guardInput(goal: string): InputGuardResult {
  const flags: string[] = [];
  if (ILLEGAL.test(goal)) {
    return { blocked: true, flags: ['illegal'], effectiveGoal: '', parseGoal: '', message: '该请求涉及内幕信息或操纵市场等违法违规行为，X-Buddy 无法协助。' };
  }
  if (PREDICT.test(goal)) flags.push('prediction');
  if (ADVICE.test(goal)) flags.push('advice');
  if (GUARANTEE.test(goal)) flags.push('guarantee');
  if (!flags.length) return { blocked: false, flags, effectiveGoal: goal, parseGoal: goal };
  const cleaned = goal
    .replace(/[？?]/g, '')
    .replace(PREDICT, '')
    .replace(ADVICE, '')
    .replace(GUARANTEE, '')
    .trim();
  return {
    blocked: false,
    flags,
    parseGoal: cleaned || goal,
    effectiveGoal: `${cleaned || goal}（已改写：提供可验证的数据、估值区间与风险因素，不做涨跌预测或买卖建议）`,
    message: '检测到涨跌预测 / 买卖建议 / 收益承诺类诉求。X-Buddy 不输出确定性预测、收益承诺或直接买卖建议，已改写为基于证据的研究任务。',
  };
}

const BANNED: [RegExp, string][] = [
  [/必涨|必跌|稳赚|包赚|保本|翻倍|无风险/g, '确定性/收益承诺表述'],
  [/(建议|推荐|可以|应该)(买入|卖出|加仓|减仓|清仓|抄底|持有)/g, '买卖建议'],
  [/强烈推荐|重点推荐/g, '荐股表述'],
  [/目标价/g, '目标价'],
  [/(将|会|一定会|必然)(大幅)?(上涨|下跌|反弹|见顶|见底)/g, '涨跌预测'],
];

/** 输出侧合规：扫描并移除违规表述，返回违规清单 */
export function guardOutput(text: string): { text: string; violations: string[] } {
  const violations: string[] = [];
  let out = text;
  for (const [re, label] of BANNED) {
    out = out.replace(re, (m) => {
      violations.push(`${label}：「${m}」`);
      return '〔已移除不合规表述〕';
    });
  }
  return { text: out, violations };
}

/** 结论分级校验：事实必须有正常证据；证据缺失/冲突/失败则降级为“不确定”；仅有计算证据则为“推断” */
export function gradeClaims(claims: Claim[], evidence: Evidence[]): Claim[] {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  return claims.map((c) => {
    const evs = c.evidenceIds.map((id) => byId.get(id)).filter(Boolean) as Evidence[];
    if (!evs.length) return { ...c, kind: 'uncertain' };
    if (evs.some((e) => e.status === 'missing' || e.status === 'error' || e.status === 'conflict' || e.status === 'stale')) return { ...c, kind: 'uncertain' };
    if (c.kind === 'fact' && evs.some((e) => e.status === 'derived')) return { ...c, kind: 'inference' };
    return c;
  });
}

export const DISCLAIMER =
  '本报告由 X-Buddy 基于所列数据源自动生成，仅供研究参考，不构成任何投资建议、收益承诺或涨跌预测。事实均标注来源、时点、单位与口径；推断与不确定信息已单独标识。市场有风险，决策需独立判断。';
