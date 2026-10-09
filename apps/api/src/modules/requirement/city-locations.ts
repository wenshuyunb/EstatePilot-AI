/**
 * 多城市行政区与板块地址库。
 *
 * ============================================================================
 * 为什么需要这个文件
 * ============================================================================
 * 原先的地址识别是**单城市架构**：解析器里写死 `SHANGHAI_DISTRICTS`
 * 加一张上海专属别名表。后果是：
 *   - 客户说"思明区三房"→ 完全识别不出位置
 *   - 系统把需求当"无区域偏好"处理 → 推荐结果与客户预期不符
 *   - 即使贝壳恢复，厦门等城市也用不了
 *
 * 本文件把城市地址数据抽出来集中管理，并支持：
 *   1. **按城市选地址**：先选城市（如厦门），再选该城市的区/板块
 *   2. **自动推断**：客户提到"五缘湾"，系统能推断出这是厦门
 *
 * ============================================================================
 * 维护原则
 * ============================================================================
 *   - **只收录强特征名称**：像"新区""高新区""开发区"这类多城市共有的
 *     绝不收录 —— 歧义映射会把客户需求导到错误的城市，比识别不出更糟。
 *   - **跨城市重名必须去掉**：如"鼓楼"（南京/福州都有）、
 *     "金山"（上海/厦门都有）、"台江"（福州/台州）。
 *     宁可识别不出，也不要猜错。
 *   - 板块名应收敛到贝壳/中介实际使用的说法。
 */

/** 单个城市的地址数据 */
export interface CityLocationProfile {
  /** 城市名 */
  city: string;
  /** 贝壳城市 ID（用于 API 调用） */
  beikeCityCode?: string;
  /** 行政区（用全称，如"思明区"） */
  districts: string[];
  /** 常用板块/商圈（客户口语里最常出现的） */
  subDistricts: string[];
  /**
   * 板块 → 所属行政区 的映射。
   *
   * 为什么需要：客户说"五缘湾三房"时，我们既要能定位到板块，
   * 也要知道它属于湖里区（用于硬性过滤与区域放宽重试）。
   */
  subDistrictToDistrict: Record<string, string>;
  /**
   * 城市特有的**区域俗称** → 展开成的行政区列表。
   *
   * 为什么单独放：这类说法（如厦门的"岛内""岛外"）不是行政区也不是板块，
   * 但客户用得极频繁。识别不出会导致区域过滤完全失效 ——
   * 客户说"岛内两房"，系统却当成"没有区域要求"，推荐结果必然不符预期。
   */
  regionAliases?: Record<string, string[]>;
}

/**
 * 厦门 —— 用户主战场，覆盖到板块级别。
 *
 * 岛内两区（思明、湖里）是成交主力，板块划分按中介习惯。
 */
const XIAMEN: CityLocationProfile = {
  city: '厦门',
  beikeCityCode: '350200',
  districts: ['思明区', '湖里区', '集美区', '海沧区', '同安区', '翔安区'],
  subDistricts: [
    // ---- 思明区 ----
    '莲前', '前埔', '禾祥', '文灶', '厦大', '曾厝垵', '轮渡', '中山路',
    '湖滨', '槟榔', '松柏', '筼筜', '云顶', '会展中心', '观音山', '软件园',
    '瑞景', '莲坂', '火车站', '富山', '金鸡亭', '龙山', '东浦', '洪文',
    '鼓浪屿', '黄厝', '环岛路',
    // ---- 湖里区 ----
    '五缘湾', '钟宅', '枋湖', '江头', '高崎', '殿前', '东渡', '海天',
    '湖边水库', '县后', '安兜', '蔡塘', '后坑', 'SM广场',
    '台湾街', '吕岭', '金尚', '穆厝', '坂上', '五通',
    // ⚠️ 刻意不收录"金山"：上海金山是**行政区**，厦门金山是**板块**，
    //    两者都真实存在且都是高频说法。收录进推断表会导致
    //    "金山"被猜成厦门（而上海那条路径优先级更高），产生不一致。
    //    代价：客户单说"金山"时不推断城市，由经纪人手动选 —— 宁可漏，不可错。
    // ---- 集美区 ----
    '集美学村', '杏林', '杏林湾', '灌口', '后溪', '侨英', 'ioi',
    '园博苑', '北站', '软三',
    // ---- 海沧区 ----
    '海沧湾', '新阳', '东孚', '嵩屿', '未来海岸', '天竺山',
    // ---- 同安区 ----
    '同安老城', '环东海域', '西柯', '新民',
    // ---- 翔安区 ----
    '马巷', '新店', '翔安新城', '大嶝', '内厝',
  ],
  subDistrictToDistrict: {
    莲前: '思明区', 前埔: '思明区', 禾祥: '思明区', 文灶: '思明区',
    厦大: '思明区', 曾厝垵: '思明区', 轮渡: '思明区', 中山路: '思明区',
    湖滨: '思明区', 槟榔: '思明区', 松柏: '思明区', 筼筜: '思明区',
    云顶: '思明区', 会展中心: '思明区', 观音山: '思明区', 软件园: '思明区',
    瑞景: '思明区', 莲坂: '思明区', 火车站: '思明区', 富山: '思明区',
    金鸡亭: '思明区', 龙山: '思明区', 东浦: '思明区', 洪文: '思明区',
    鼓浪屿: '思明区', 黄厝: '思明区', 环岛路: '思明区',

    五缘湾: '湖里区', 钟宅: '湖里区', 枋湖: '湖里区', 江头: '湖里区',
    高崎: '湖里区', 殿前: '湖里区', 东渡: '湖里区', 海天: '湖里区',
    金山: '湖里区', 湖边水库: '湖里区', 县后: '湖里区', 安兜: '湖里区',
    蔡塘: '湖里区', 后坑: '湖里区', SM广场: '湖里区', 台湾街: '湖里区',
    吕岭: '湖里区', 金尚: '湖里区', 穆厝: '湖里区', 坂上: '湖里区',
    五通: '湖里区',

    集美学村: '集美区', 杏林: '集美区', 杏林湾: '集美区', 灌口: '集美区',
    后溪: '集美区', 侨英: '集美区', ioi: '集美区', 园博苑: '集美区',
    北站: '集美区', 软三: '集美区',

    海沧湾: '海沧区', 新阳: '海沧区', 东孚: '海沧区', 嵩屿: '海沧区',
    未来海岸: '海沧区', 天竺山: '海沧区',

    同安老城: '同安区', 环东海域: '同安区', 西柯: '同安区', 新民: '同安区',

    马巷: '翔安区', 新店: '翔安区', 翔安新城: '翔安区', 大嶝: '翔安区',
    内厝: '翔安区',
  },
  // 厦门特有俗称：岛内 = 思明 + 湖里（被海沧/集美等隔开的核心两区）
  // 客户说"我要岛内的房子"是极高频表达，识别不出会丢掉整个区域约束。
  regionAliases: {
    岛内: ['思明区', '湖里区'],
    厦门岛内: ['思明区', '湖里区'],
    岛外: ['集美区', '海沧区', '同安区', '翔安区'],
    厦门岛外: ['集美区', '海沧区', '同安区', '翔安区'],
  },
};

/** 福州 */
const FUZHOU: CityLocationProfile = {
  city: '福州',
  beikeCityCode: '350100',
  // ⚠️ `districts` 刻意排除"鼓楼区"与"台江区"：
  //    鼓楼区 —— 南京也有，且南京是更大的房产市场
  //    台江区 —— 易与浙江台州混淆
  //    排除后这两处的房源不会被误判成福州，代价是识别不出（宁可漏，不可错）。
  //
  //    注意：`subDistrictToDistrict` 里仍会出现这两个区 —— 那是**板块到区的
  //    内部映射**（东街口确实属于鼓楼区），只在已确认城市为福州时才使用，
  //    不参与反向的城市推断，因此不会引入歧义。
  districts: ['仓山区', '晋安区', '马尾区', '长乐区', '闽侯县'],
  subDistricts: [
    '五四北', '东街口', '三坊七巷', '温泉', '王庄',
    '茶亭', '上街', '大学城', '南屿', '琅岐',
  ],
  subDistrictToDistrict: {
    五四北: '晋安区',
    东街口: '鼓楼区',
    三坊七巷: '鼓楼区',
    温泉: '鼓楼区',
    王庄: '晋安区',
    茶亭: '台江区',
    上街: '闽侯县',
    大学城: '闽侯县',
    南屿: '闽侯县',
    琅岐: '马尾区',
  },
};

/** 泉州 */
const QUANZHOU: CityLocationProfile = {
  city: '泉州',
  beikeCityCode: '350500',
  districts: ['鲤城区', '丰泽区', '洛江区', '泉港区', '晋江市', '石狮市', '南安市', '惠安县'],
  subDistricts: ['东海', '城东', '江南', '北峰', '清源山', '洛阳桥', '安海', '水头'],
  subDistrictToDistrict: {
    东海: '丰泽区', 城东: '丰泽区', 江南: '鲤城区', 北峰: '丰泽区',
    清源山: '丰泽区', 洛阳桥: '洛江区', 安海: '晋江市', 水头: '南安市',
  },
};

/** 漳州 */
const ZHANGZHOU: CityLocationProfile = {
  city: '漳州',
  beikeCityCode: '350600',
  districts: ['芗城区', '龙文区', '龙海区', '长泰区'],
  subDistricts: ['角美', '蓝田', '碧湖', '圆山'],
  subDistrictToDistrict: {
    角美: '龙海区', 蓝田: '龙文区', 碧湖: '龙文区', 圆山: '芗城区',
  },
};

/** 上海（原有支持，保持完整） */
const SHANGHAI: CityLocationProfile = {
  city: '上海',
  beikeCityCode: '310000',
  districts: [
    '浦东新区', '徐汇区', '静安区', '黄浦区', '长宁区', '普陀区', '虹口区',
    '杨浦区', '闵行区', '宝山区', '嘉定区', '金山区', '松江区', '青浦区',
    '奉贤区', '崇明区',
  ],
  subDistricts: [
    '张江', '金桥', '陆家嘴', '外高桥', '三林', '康桥', '周浦', '唐镇',
    '曹路', '高行', '金杨', '洋泾', '花木', '北蔡', '川沙', '惠南', '临港',
    '徐家汇', '田林', '漕河泾', '古美', '七宝', '莘庄', '春申', '大宁',
    '彭浦', '不夜城', '五角场', '新江湾城', '中原', '控江路', '虹桥',
    '中山公园', '天山', '长寿路', '曹杨', '真如', '曲阳', '凉城',
    '四川北路', '北外滩',
  ],
  subDistrictToDistrict: {
    张江: '浦东新区', 金桥: '浦东新区', 陆家嘴: '浦东新区', 外高桥: '浦东新区',
    三林: '浦东新区', 康桥: '浦东新区', 周浦: '浦东新区', 唐镇: '浦东新区',
    曹路: '浦东新区', 高行: '浦东新区', 金杨: '浦东新区', 洋泾: '浦东新区',
    花木: '浦东新区', 北蔡: '浦东新区', 川沙: '浦东新区', 惠南: '浦东新区',
    临港: '浦东新区',
    徐家汇: '徐汇区', 田林: '徐汇区', 漕河泾: '徐汇区',
    古美: '闵行区', 七宝: '闵行区', 莘庄: '闵行区', 春申: '闵行区',
    大宁: '静安区', 彭浦: '静安区', 不夜城: '静安区',
    五角场: '杨浦区', 新江湾城: '杨浦区', 中原: '杨浦区', 控江路: '杨浦区',
    虹桥: '长宁区', 中山公园: '长宁区', 天山: '长宁区',
    长寿路: '普陀区', 曹杨: '普陀区', 真如: '普陀区',
    曲阳: '虹口区', 凉城: '虹口区', 四川北路: '虹口区', 北外滩: '虹口区',
  },
};

/**
 * 全部城市的地址档案。
 *
 * ⚠️ 重名处理：多个城市共有同一板块名时（如"金山"），
 * `CITY_BY_SUB_DISTRICT` 会**标记为歧义并排除**，
 * 避免客户说"金山"时被导到错误城市。
 * 但如果消息里已明确城市（"厦门金山"），则按明确城市解析。
 */
export const CITY_LOCATION_PROFILES: readonly CityLocationProfile[] = [
  XIAMEN,
  FUZHOU,
  QUANZHOU,
  ZHANGZHOU,
  SHANGHAI,
];

/** 按城市名取档案 */
export function getCityProfile(city: string | null | undefined): CityLocationProfile | null {
  if (!city) return null;
  const trimmed = city.trim();
  return CITY_LOCATION_PROFILES.find((profile) => profile.city === trimmed) ?? null;
}

/**
 * 板块 → 城市 的反查表（仅收录**无歧义**的板块）。
 *
 * ============================================================================
 * 为什么不能直接用 subDistricts 反查
 * ============================================================================
 * 板块名本身可能对应**多个城市的同名行政区**。
 * 例如福州"东街口"属于鼓楼区，而南京也有鼓楼区 ——
 * 如果客户（或另一座城市的客户）提到类似地名，反查会猜错城市。
 *
 * 因此这里额外做一层防护：**只收录那些所属行政区本身无歧义的板块**。
 * 宁可识别不出城市（让经纪人手动选），也不要把客户需求导到错误城市。
 */
export const CITY_BY_SUB_DISTRICT: ReadonlyMap<string, string> = (() => {
  // 先找出所有城市里"有歧义"的行政区名
  const ambiguousDistricts = new Set<string>();
  {
    const owners = new Map<string, Set<string>>();
    for (const profile of CITY_LOCATION_PROFILES) {
      for (const district of profile.districts) {
        const set = owners.get(district) ?? new Set<string>();
        set.add(profile.city);
        owners.set(district, set);
      }
    }
    for (const [district, cities] of owners) {
      if (cities.size > 1) ambiguousDistricts.add(district);
    }
  }

  const owners = new Map<string, Set<string>>();

  for (const profile of CITY_LOCATION_PROFILES) {
    for (const sub of profile.subDistricts) {
      // 该板块所属的行政区若本身有歧义，则该板块也不参与城市推断
      const district = profile.subDistrictToDistrict[sub];
      if (district && ambiguousDistricts.has(district)) continue;

      const set = owners.get(sub) ?? new Set<string>();
      set.add(profile.city);
      owners.set(sub, set);
    }
  }

  const unambiguous = new Map<string, string>();
  for (const [sub, cities] of owners) {
    // 只有一个城市拥有 → 无歧义
    if (cities.size === 1) {
      unambiguous.set(sub, [...cities][0]!);
    }
  }
  return unambiguous;
})();

/**
 * 行政区 → 城市 的反查表（仅收录**无歧义**的区）。
 *
 * 行政区比板块更少重名，但仍需防护（如"鼓楼区"南京/福州都有）。
 * 注意：这里用**全称**匹配，因为客户说"鼓楼区"时通常带"区"字。
 */
export const CITY_BY_DISTRICT: ReadonlyMap<string, string> = (() => {
  const owners = new Map<string, Set<string>>();

  for (const profile of CITY_LOCATION_PROFILES) {
    for (const district of profile.districts) {
      const set = owners.get(district) ?? new Set<string>();
      set.add(profile.city);
      owners.set(district, set);
    }
  }

  const unambiguous = new Map<string, string>();
  for (const [district, cities] of owners) {
    if (cities.size === 1) {
      unambiguous.set(district, [...cities][0]!);
    }
  }
  return unambiguous;
})();

/** 所有支持的板块（跨城市去重） */
export function allSubDistricts(): string[] {
  const set = new Set<string>();
  for (const profile of CITY_LOCATION_PROFILES) {
    for (const sub of profile.subDistricts) set.add(sub);
  }
  return [...set];
}

/** 所有支持的行政区（跨城市去重） */
export function allDistricts(): string[] {
  const set = new Set<string>();
  for (const profile of CITY_LOCATION_PROFILES) {
    for (const district of profile.districts) set.add(district);
  }
  return [...set];
}

/** 某个城市支持的区域（供前端"地址筛选"下拉使用） */
export function listCitiesWithAreas(): Array<{
  city: string;
  districts: string[];
  subDistricts: string[];
}> {
  return CITY_LOCATION_PROFILES.map((profile) => ({
    city: profile.city,
    districts: [...profile.districts],
    subDistricts: [...profile.subDistricts],
  }));
}

/**
 * 过滤出**确实属于目标城市**的行政区。
 *
 * ============================================================================
 * 为什么需要这个清洗
 * ============================================================================
 * 客户画像里的 `districts` 会跨多轮对话累积。如果客户先聊厦门、后聊上海，
 * 画像里会同时存在"浦东新区"和"思明区"。
 *
 * 此时若经纪人在界面上把城市切到"上海"、但不指定具体区，
 * 那些**厦门的区名仍会参与硬筛** —— 上海房源会被"思明区"这个条件全部筛掉，
 * 表现为"选了上海却说没有可用房源"。这是实测踩到的真实问题。
 *
 * 清洗规则（保守优先）：
 *   - 城市**已知**（在地址库里）→ 只保留属于该城市的区名
 *   - 城市**未知**（不在地址库里，如贝壳支持但我们没收录的城市）→
 *     **原样保留**，因为我们没有依据判断哪些区名属于它，
 *     贸然清空会把客户真实需求也丢掉
 */
export function districtsBelongingToCity(
  districts: readonly string[],
  city: string | null | undefined,
): string[] {
  if (districts.length === 0) return [];

  const profile = getCityProfile(city);

  // 城市未知 → 无从判断，保守地原样保留
  if (!profile) return [...districts];

  const allowed = new Set<string>();
  for (const district of profile.districts) {
    allowed.add(district);
    // 同时接受简称（客户/画像里可能存的是"浦东"而不是"浦东新区"）
    allowed.add(district.replace(/[区县市]$/, ''));
  }
  // 板块名也算该城市的合法区域标识 —— 画像里可能把板块存进 districts
  // （抽取时若只识别出板块，某些路径会写到 districts 字段）
  for (const sub of profile.subDistricts) allowed.add(sub);

  return districts.filter(
    (district) =>
      allowed.has(district) ||
      profile.districts.some(
        (full) => full.includes(district) || district.includes(full.replace(/[区县市]$/, '')),
      ),
  );
}

/**
 * 过滤出**确实属于目标城市**的板块。
 *
 * ============================================================================
 * 这个函数是踩坑之后补的
 * ============================================================================
 * 最初只清洗了 `districts`，结果仍报"选了上海却说没有房源"。日志显示搜索
 * 条件里带着「软件园」—— 那是**厦门的板块**，而上海的 41 套房源里
 * 没有任何一套的 subDistrict 叫"软件园"，条件一加上就把全部候选筛空了。
 *
 * 关键认识：**跨城市的不只是行政区，板块同样会串**。
 * 画像里的 `subDistricts` 是逐轮累积的，客户上一个城市说的板块会留下来，
 * 换城市后变成一条永远匹配不上的过滤条件。
 *
 * 清洗规则与行政区一致：
 *   - 城市已知 → 只保留该城市档案里的板块（含"XX附近"这类动态识别的）
 *   - 城市未知 → 原样保留
 *
 * ⚠️ 双城重名板块（如"金山"上海/厦门都有）即使属于目标城市也会保留 ——
 *    因为此时城市是明确的，不存在歧义。
 */
export function subDistrictsBelongingToCity(
  subDistricts: readonly string[],
  city: string | null | undefined,
): string[] {
  if (subDistricts.length === 0) return [];

  const profile = getCityProfile(city);

  // 城市未知 → 无从判断，保守地原样保留
  if (!profile) return [...subDistricts];

  const allowed = new Set(profile.subDistricts);
  return subDistricts.filter((sub) => allowed.has(sub));
}

/**
 * 一次性清洗行政区与板块。
 *
 * 搜索条件构造前调用，避免跨城市残留把候选筛空。
 */
export function sanitizeRegionsForCity(
  regions: { districts: readonly string[]; subDistricts: readonly string[] },
  city: string | null | undefined,
): { districts: string[]; subDistricts: string[] } {
  return {
    districts: districtsBelongingToCity(regions.districts, city),
    subDistricts: subDistrictsBelongingToCity(regions.subDistricts, city),
  };
}
