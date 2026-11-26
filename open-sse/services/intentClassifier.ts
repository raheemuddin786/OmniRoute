/**
 * Multilingual Intent Detection for AutoCombo
 *
 * Classifies prompts as: code | math | reasoning | creative | simple | medium
 * using keywords in 9 languages (EN, PT-BR, ES, ZH, JA, RU, DE, KO, AR).
 *
 * Inspired by ClawRouter (BlockRunAI) multilingual routing system.
 * Execution: purely synchronous, <1ms, no I/O.
 */

export type IntentType =
  | "code"
  | "math"
  | "reasoning"
  | "creative"
  | "simple"
  | "medium"
  | "planning"
  | "debugging"
  | "documentation"
  | "review";

export interface ClassificationResult {
  type: IntentType;
  confidence: number;
  signals: string[];
  // Raw keyword match counts per intent type for debugging/eval
  keywordCounts?: Record<IntentType, number>;
  // Detected language hints (e.g. "zh", "ja", "ko", "ru", "ar")
  languageHints?: string[];
}

export const CODE_KEYWORDS: readonly string[] = [
  // English
  "function",
  "class",
  "import",
  "def",
  "SELECT",
  "async",
  "await",
  "const",
  "let",
  "var",
  "return",
  "```",
  "algorithm",
  "compile",
  "debug",
  "refactor",
  "typescript",
  "python",
  "javascript",
  "code",
  "implement",
  "write a",
  "create a component",
  "endpoint",
  "repository",
  "deploy",
  "install",
  "script",
  "api",
  "database",
  "query",
  "schema",
  "interface",
  "generic",
  "enum",
  "module",
  "package",
  "dependency",
  // Português (PT-BR)
  "função",
  "classe",
  "importar",
  "definir",
  "consulta",
  "assíncrono",
  "aguardar",
  "constante",
  "variável",
  "retornar",
  "algoritmo",
  "compilar",
  "depurar",
  "refatorar",
  "código",
  "implementar",
  "criar um",
  "componente",
  "como fazer",
  "repositório",
  "configurar",
  "instalar",
  "banco de dados",
  "escrever uma função",
  "criar uma classe",
  // Español
  "función",
  "clase",
  "importar",
  "definir",
  "consulta",
  "asíncrono",
  "esperar",
  "constante",
  "variable",
  "retornar",
  "algoritmo",
  "compilar",
  "depurar",
  "refactorizar",
  "código",
  "implementar",
  // 中文
  "函数",
  "类",
  "导入",
  "定义",
  "查询",
  "异步",
  "等待",
  "常量",
  "变量",
  "返回",
  "算法",
  "编译",
  "调试",
  "代码",
  // 日本語
  "関数",
  "クラス",
  "インポート",
  "非同期",
  "定数",
  "変数",
  "コード",
  "アルゴリズム",
  // Русский
  "функция",
  "класс",
  "импорт",
  "запрос",
  "асинхронный",
  "константа",
  "переменная",
  "алгоритм",
  "код",
  // Deutsch
  "funktion",
  "klasse",
  "importieren",
  "abfrage",
  "asynchron",
  "konstante",
  "variable",
  "algorithmus",
  "code",
  // 한국어
  "함수",
  "클래스",
  "가져오기",
  "정의",
  "쿼리",
  "비동기",
  "대기",
  "상수",
  "변수",
  "반환",
  "코드",
  // العربية
  "دالة",
  "فئة",
  "استيراد",
  "استعلام",
  "غير متزامن",
  "ثابت",
  "متغير",
  "كود",
  "خوارزمية",
];

export const REASONING_KEYWORDS: readonly string[] = [
  // English
  "prove",
  "theorem",
  "derive",
  "step by step",
  "chain of thought",
  "formally",
  "mathematical",
  "proof",
  "logically",
  "analyze",
  "reasoning",
  "deduce",
  "infer",
  "hypothesis",
  "convergence",
  // Português (PT-BR)
  "provar",
  "teorema",
  "derivar",
  "passo a passo",
  "cadeia de pensamento",
  "formalmente",
  "matemático",
  "prova",
  "logicamente",
  "analisar",
  "raciocínio",
  "deduzir",
  "inferir",
  "hipótese",
  "demonstrar",
  "cálculo",
  "equação diferencial",
  "integral",
  "otimização",
  // Español
  "demostrar",
  "teorema",
  "derivar",
  "paso a paso",
  "formalmente",
  "matemático",
  "lógicamente",
  // 中文
  "证明",
  "定理",
  "推导",
  "逐步",
  "思维链",
  "数学",
  "逻辑",
  "分析",
  // 日本語
  "証明",
  "定理",
  "導出",
  "論理的",
  "分析",
  // Русский
  "доказать",
  "теорема",
  "шаг за шагом",
  "математически",
  "логически",
  // Deutsch
  "beweisen",
  "theorem",
  "schritt für schritt",
  "mathematisch",
  "logisch",
  // 한국어
  "증명",
  "정리",
  "단계별",
  "수학적",
  "논리적",
  // العربية
  "إثبات",
  "نظرية",
  "خطوة بخطوة",
  "رياضي",
  "منطقياً",
];

export const MATH_KEYWORDS: readonly string[] = [
  // English
  "calculate",
  "solve",
  "equation",
  "proof",
  "formula",
  "integral",
  "derivative",
  "theorem",
  "algebra",
  "geometry",
  "arithmetic",
  "polynomial",
  "matrix",
  "vector",
  "statistics",
  "probability",
  // Português (PT-BR)
  "calcular",
  "resolver",
  "equação",
  "fórmula",
  "integral",
  "derivada",
  "teorema",
  "álgebra",
  "geometria",
  "aritmética",
  "polinômio",
  "matriz",
  "vetor",
  "estatística",
  "probabilidade",
  // Español
  "calcular",
  "resolver",
  "ecuación",
  "fórmula",
  "integral",
  "derivada",
  "teorema",
  "álgebra",
  "geometría",
  "aritmética",
  "polinomio",
  "matriz",
  "vector",
  "estadística",
  "probabilidad",
  // 中文
  "计算",
  "求解",
  "方程",
  "公式",
  "积分",
  "导数",
  "代数",
  "几何",
  "算术",
  "多项式",
  "矩阵",
  "向量",
  "统计",
  "概率",
  // 日本語
  "計算",
  "方程式",
  "公式",
  "積分",
  "微分",
  "代数",
  "幾何学",
  "算術",
  "多項式",
  "行列",
  "ベクトル",
  "統計",
  "確率",
  // Русский
  "вычислить",
  "решить",
  "уравнение",
  "формула",
  "интеграл",
  "производная",
  "алгебра",
  "геометрия",
  "арифметика",
  "полином",
  "матрица",
  "вектор",
  "статистика",
  "вероятность",
  // Deutsch
  "berechnen",
  "gleichung",
  "formel",
  "integral",
  "ableitung",
  "algebra",
  "geometrie",
  "arithmetik",
  "polynom",
  "matrix",
  "vektor",
  "statistik",
  "wahrscheinlichkeit",
  // 한국어
  "계산",
  "방정식",
  "공식",
  "적분",
  "미분",
  "대수",
  "기하학",
  "산술",
  "다항식",
  "행렬",
  "벡터",
  "통계",
  "확률",
  // العربية
  "حل",
  "معادلة",
  "صيغة",
  "تكامل",
  "مشتق",
  "جبر",
  "هندسة",
  "حساب",
  "متعدد الحدود",
  "مصفوفة",
  "متجه",
  "إحصاء",
  "احتمال",
];

export const CREATIVE_KEYWORDS: readonly string[] = [
  // English
  "write",
  "story",
  "poem",
  "creative",
  "brainstorm",
  "blog",
  "article",
  "copywrite",
  "marketing",
  "narrative",
  "fiction",
  "screenplay",
  "lyrics",
  "essay",
  // Português (PT-BR)
  "escrever",
  "história",
  "poema",
  "criativo",
  "brainstorm",
  "blog",
  "artigo",
  "redação",
  "marketing",
  "narrativa",
  "ficção",
  "roteiro",
  "letras",
  "ensaio",
  // Español
  "escribir",
  "historia",
  "poema",
  "creativo",
  "blog",
  "artículo",
  "redacción",
  "marketing",
  "narrativa",
  "ficción",
  "guion",
  "letras",
  "ensayo",
  // 中文
  "写",
  "故事",
  "诗",
  "创意",
  "头脑风暴",
  "博客",
  "文章",
  "文案",
  "营销",
  "叙事",
  "小说",
  "剧本",
  "歌词",
  "散文",
  // 日本語
  "書く",
  "物語",
  "詩",
  "クリエイティブ",
  "ブログ",
  "記事",
  "コピーライティング",
  "マーケティング",
  "ナラティブ",
  "小説",
  "脚本",
  "歌詞",
  "エッセイ",
  // Русский
  "написать",
  "история",
  "стихотворение",
  "креативный",
  "блог",
  "статья",
  "копирайтинг",
  "маркетинг",
  "нарратив",
  "фантастика",
  "сценарий",
  "текст песни",
  "эссе",
  // Deutsch
  "schreiben",
  "geschichte",
  "gedicht",
  "kreativ",
  "blog",
  "artikel",
  "texten",
  "marketing",
  "erzählung",
  "fiktion",
  "drehbuch",
  "songtext",
  "aufsatz",
  // 한국어
  "쓰기",
  "이야기",
  "시",
  "창의적",
  "블로그",
  "기사",
  "카피라이팅",
  "마케팅",
  "서사",
  "소설",
  "시나리오",
  "가사",
  "에세이",
  // العربية
  "كتابة",
  "قصة",
  "قصيدة",
  "إبداعي",
  "مقال",
  "تسويق",
  "سرد",
  "رواية",
  "سيناريو",
  "كلمات أغنية",
  "مقالة",
];

export const PLANNING_KEYWORDS: readonly string[] = [
  // English
  "plan",
  "planning",
  "roadmap",
  "strategy",
  "design",
  "architecture",
  "blueprint",
  "architect",
  "redesign",
  "workflow",
  "multi-step",
  "multi-page",
  "system architecture",
  "end-to-end",
  "feature planning",
  // Português
  "planejar",
  "planejamento",
  "estratégia",
  "design",
  "arquitetura",
  "projeto",
  "fluxo de trabalho",
  // Español
  "planificar",
  "planificación",
  "estrategia",
  "diseño",
  "arquitectura",
  "flujo de trabajo",
  // 中文
  "规划",
  "计划",
  "策略",
  "设计",
  "架构",
  "工作流",
  // 日本語
  "計画",
  "プラン",
  "設計",
  "アーキテクチャ",
  // Русский
  "планирование",
  "планировать",
  "стратегия",
  "архитектура",
  // Deutsch
  "planen",
  "planung",
  "strategie",
  "architektur",
  // 한국어
  "계획",
  "기획",
  "전략",
  "설계",
  // العربية
  "تخطيط",
  "خطة",
  "استراتيجية",
  "هندسة",
];

export const DEBUGGING_KEYWORDS: readonly string[] = [
  // English
  "debug",
  "debugging",
  "fix bug",
  "fix error",
  "troubleshoot",
  "trace",
  "stack trace",
  "error",
  "exception",
  "crash",
  "breakpoint",
  // Português
  "depurar",
  "depuração",
  "corrigir bug",
  "corrigir erro",
  "rastrear",
  "stack trace",
  "erro",
  "exceção",
  "falha",
  // Español
  "depurar",
  "depuración",
  "corregir error",
  "rastrear",
  "traza",
  "error",
  "excepción",
  "fallo",
  // 中文
  "调试",
  "修复bug",
  "修复错误",
  "排查",
  "堆栈跟踪",
  "错误",
  "异常",
  "崩溃",
  // 日本語
  "デバッグ",
  "デバッギング",
  "バグ修正",
  "エラー修正",
  "スタックトレース",
  "エラー",
  "例外",
  // Русский
  "отладка",
  "исправить ошибку",
  "трассировка",
  "ошибка",
  "исключение",
  // Deutsch
  "debuggen",
  "fehler beheben",
  "stack trace",
  "fehler",
  "ausnahme",
  // 한국어
  "디버깅",
  "버그 수정",
  "오류 수정",
  "스택 트레이스",
  // العربية
  "تصحيح الأخطاء",
  "إصلاح خطأ",
  "تتبع المكدس",
  "خطأ",
  "استثناء",
];

export const DOCUMENTATION_KEYWORDS: readonly string[] = [
  // English
  "document",
  "documentation",
  "docs",
  "readme",
  "comment",
  "comments",
  "docstring",
  "docstrings",
  "write docs",
  "api docs",
  "technical documentation",
  // Português
  "documentar",
  "documentação",
  "comentário",
  "comentários",
  "docstring",
  "escrever docs",
  // Español
  "documentar",
  "documentación",
  "comentario",
  "comentarios",
  "docstring",
  "escribir docs",
  // 中文
  "文档",
  "注释",
  "注释文档",
  "编写文档",
  // 日本語
  "ドキュメント",
  "ドキュメンテーション",
  "コメント",
  "ドックストリング",
  // Русский
  "документировать",
  "документация",
  "комментарий",
  // Deutsch
  "dokumentieren",
  "dokumentation",
  "kommentar",
  // 한국어
  "문서화",
  "주석",
  // العربية
  "توثيق",
  "تعليق",
];

export const REVIEW_KEYWORDS: readonly string[] = [
  // English
  "review",
  "code review",
  "review code",
  "pull request",
  "pr review",
  "audit",
  "inspect",
  "inspection",
  "peer review",
  // Português
  "revisar",
  "revisão de código",
  "code review",
  "pull request",
  "auditoria",
  "inspecionar",
  // Español
  "revisar",
  "revisión de código",
  "code review",
  "pull request",
  "auditoría",
  "inspección",
  // 中文
  "代码审查",
  "审查代码",
  "拉取请求",
  "审计",
  "检查",
  // 日本語
  "レビュー",
  "コードレビュー",
  "プルリクエスト",
  "監査",
  "検査",
  // Русский
  "обзор",
  "код-ревью",
  "pull request",
  "аудит",
  "инспекция",
  // Deutsch
  "review",
  "code review",
  "pull request",
  "audit",
  "inspektion",
  // 한국어
  "리뷰",
  "코드 리뷰",
  "풀 리퀘스트",
  "감사",
  // العربية
  "مراجعة",
  "مراجعة الكود",
  "سحب طلب",
  "تدقيق",
  "فحص",
];

export const SIMPLE_KEYWORDS: readonly string[] = [
  // English
  "what is",
  "define",
  "translate",
  "hello",
  "yes or no",
  "summarize",
  "list",
  "tell me",
  "who is",
  // Português (PT-BR)
  "o que é",
  "definir",
  "traduzir",
  "olá",
  "oi",
  "sim ou não",
  "resumir",
  "listar",
  "me diga",
  "quem é",
  "quando foi",
  "onde fica",
  "explique brevemente",
  "de forma simples",
  // Español
  "qué es",
  "definir",
  "traducir",
  "hola",
  "resumir",
  "listar",
  // 中文
  "什么是",
  "定义",
  "翻译",
  "你好",
  "总结",
  "列出",
  // Русский
  "что такое",
  "определить",
  "перевести",
  "привет",
  "резюмировать",
  // Deutsch
  "was ist",
  "definieren",
  "übersetzen",
  "hallo",
  "zusammenfassen",
  // 한국어
  "이란",
  "정의",
  "번역",
  "안녕",
  "요약",
  // العربية
  "ما هو",
  "تعريف",
  "ترجمة",
  "مرحبا",
  "ملخص",
];

type KeywordMatcher = { pattern: RegExp } | { substring: string };

function compileKeywordMatcher(keyword: string): KeywordMatcher {
  const normalized = keyword.toLowerCase();
  if (normalized === "```" || !/\p{Script=Latin}/u.test(normalized)) {
    return { substring: normalized };
  }

  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escaped = escape(normalized);
  const alternatives = [`${escaped}(?:s|es|ed|ing)?`];
  if (normalized.endsWith("e")) alternatives.push(`${escape(normalized.slice(0, -1))}ing`);
  const last = normalized.at(-1) ?? "";
  if (/^[b-df-hj-np-tv-z]$/.test(last)) {
    alternatives.push(`${escaped}${last}(?:ed|ing)`);
  }
  return {
    pattern: new RegExp(
      `(?<![\\p{L}\\p{N}_])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}_])`,
      "iu"
    ),
  };
}

function hasKeyword(text: string, matchers: readonly KeywordMatcher[]): boolean {
  return matchers.some((matcher) =>
    "pattern" in matcher ? matcher.pattern.test(text) : text.includes(matcher.substring)
  );
}

const CODE_MATCHERS = CODE_KEYWORDS.map(compileKeywordMatcher);
const MATH_MATCHERS = MATH_KEYWORDS.map(compileKeywordMatcher);
const REASONING_MATCHERS = REASONING_KEYWORDS.map(compileKeywordMatcher);
const CREATIVE_MATCHERS = CREATIVE_KEYWORDS.map(compileKeywordMatcher);
const SIMPLE_MATCHERS = SIMPLE_KEYWORDS.map(compileKeywordMatcher);
const PLANNING_MATCHERS = PLANNING_KEYWORDS.map(compileKeywordMatcher);
const DEBUGGING_MATCHERS = DEBUGGING_KEYWORDS.map(compileKeywordMatcher);
const DOCUMENTATION_MATCHERS = DOCUMENTATION_KEYWORDS.map(compileKeywordMatcher);
const REVIEW_MATCHERS = REVIEW_KEYWORDS.map(compileKeywordMatcher);

/**
 * Classify a prompt's intent using multilingual keyword matching.
 * Priority: code > planning > debugging > documentation > review > math > reasoning > creative > simple > medium (default)
 */
export function classifyPromptIntent(prompt: string, systemPrompt?: string): IntentType {
  const fullText = `${systemPrompt ?? ""} ${prompt}`.toLowerCase();
  const wordCount = prompt.trim().split(/\s+/).length;

  if (hasKeyword(fullText, CODE_MATCHERS)) return "code";
  if (hasKeyword(fullText, PLANNING_MATCHERS)) return "planning";
  if (hasKeyword(fullText, DEBUGGING_MATCHERS)) return "debugging";
  if (hasKeyword(fullText, DOCUMENTATION_MATCHERS)) return "documentation";
  if (hasKeyword(fullText, REVIEW_MATCHERS)) return "review";
  if (hasKeyword(fullText, MATH_MATCHERS)) return "math";
  if (hasKeyword(fullText, REASONING_MATCHERS)) return "reasoning";
  if (hasKeyword(fullText, CREATIVE_MATCHERS)) return "creative";
  if (wordCount < 60 && hasKeyword(fullText, SIMPLE_MATCHERS)) return "simple";
  return "medium";
}

export interface IntentClassifierConfig {
  enabled: boolean;
  extraCodeKeywords?: string[];
  extraMathKeywords?: string[];
  extraReasoningKeywords?: string[];
  extraCreativeKeywords?: string[];
  extraSimpleKeywords?: string[];
  simpleMaxWords?: number;
}

export const DEFAULT_INTENT_CONFIG: IntentClassifierConfig = {
  enabled: true,
  simpleMaxWords: 60,
};

export type CustomKeywordWeights = Partial<Record<IntentType, readonly string[]>>;

export function classifyWithConfig(
  text: string,
  config?: CustomKeywordWeights
): ClassificationResult;
export function classifyWithConfig(
  prompt: string,
  config: IntentClassifierConfig,
  systemPrompt?: string
): IntentType;
export function classifyWithConfig(
  promptOrText: string,
  config?: IntentClassifierConfig | CustomKeywordWeights,
  systemPrompt?: string
): IntentType | ClassificationResult {
  // Legacy signature: (prompt: string, config: IntentClassifierConfig, systemPrompt?: string) => IntentType
  if (
    config &&
    ("enabled" in config || "simpleMaxWords" in config || "extraCodeKeywords" in config)
  ) {
    const legacyCfg = config as IntentClassifierConfig;
    if (!legacyCfg.enabled) return "medium";
    const fullText = `${systemPrompt ?? ""} ${promptOrText}`.toLowerCase();
    const wordCount = promptOrText.trim().split(/\s+/).length;
    const maxSimpleWords = legacyCfg.simpleMaxWords ?? 60;
    const codeKws = legacyCfg.extraCodeKeywords?.length
      ? [...CODE_MATCHERS, ...legacyCfg.extraCodeKeywords.map(compileKeywordMatcher)]
      : CODE_MATCHERS;
    const mathKws = legacyCfg.extraMathKeywords?.length
      ? [...MATH_MATCHERS, ...legacyCfg.extraMathKeywords.map(compileKeywordMatcher)]
      : MATH_MATCHERS;
    const reasoningKws = legacyCfg.extraReasoningKeywords?.length
      ? [...REASONING_MATCHERS, ...legacyCfg.extraReasoningKeywords.map(compileKeywordMatcher)]
      : REASONING_MATCHERS;
    const creativeKws = legacyCfg.extraCreativeKeywords?.length
      ? [...CREATIVE_MATCHERS, ...legacyCfg.extraCreativeKeywords.map(compileKeywordMatcher)]
      : CREATIVE_MATCHERS;
    const simpleKws = legacyCfg.extraSimpleKeywords?.length
      ? [...SIMPLE_MATCHERS, ...legacyCfg.extraSimpleKeywords.map(compileKeywordMatcher)]
      : SIMPLE_MATCHERS;

    if (hasKeyword(fullText, codeKws)) return "code";
    if (hasKeyword(fullText, mathKws)) return "math";
    if (hasKeyword(fullText, reasoningKws)) return "reasoning";
    if (hasKeyword(fullText, creativeKws)) return "creative";
    if (wordCount < maxSimpleWords && hasKeyword(fullText, simpleKws)) return "simple";
    return "medium";
  }

  // Enhanced signature: (text: string, config?: CustomKeywordWeights) => ClassificationResult
  const customWeights = (config as CustomKeywordWeights) || {};
  const lower = promptOrText.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  const kw: Record<string, readonly string[]> = {
    code: customWeights.code ?? CODE_KEYWORDS,
    math: customWeights.math ?? MATH_KEYWORDS,
    reasoning: customWeights.reasoning ?? REASONING_KEYWORDS,
    creative: customWeights.creative ?? CREATIVE_KEYWORDS,
    simple: customWeights.simple ?? SIMPLE_KEYWORDS,
    planning: customWeights.planning ?? PLANNING_KEYWORDS,
    debugging: customWeights.debugging ?? DEBUGGING_KEYWORDS,
    documentation: customWeights.documentation ?? DOCUMENTATION_KEYWORDS,
    review: customWeights.review ?? REVIEW_KEYWORDS,
  };

  const counts: Record<IntentType, number> = {
    code: 0,
    math: 0,
    reasoning: 0,
    creative: 0,
    simple: 0,
    medium: 0,
    planning: 0,
    debugging: 0,
    documentation: 0,
    review: 0,
  };

  for (const [t, arr] of Object.entries(kw)) {
    counts[t as IntentType] = arr.filter((k) => lower.includes(k.toLowerCase())).length;
  }

  // Detect language hints
  const languageHints: string[] = [];
  if (/[\u4e00-\u9fa5]/.test(promptOrText)) languageHints.push("zh");
  if (/[\u3040-\u30ff]/.test(promptOrText)) languageHints.push("ja");
  if (/[\uac00-\ud7af]/.test(promptOrText)) languageHints.push("ko");
  if (/[\u0400-\u04ff]/.test(promptOrText)) languageHints.push("ru");
  if (/[\u0600-\u06ff]/.test(promptOrText)) languageHints.push("ar");

  // Determine highest matching type among priority candidates
  const prioritizedTypes: IntentType[] = [
    "planning",
    "debugging",
    "documentation",
    "review",
    "code",
    "math",
    "reasoning",
    "creative",
    "simple",
  ];

  let bestType: IntentType = "medium";
  for (const pt of prioritizedTypes) {
    if (counts[pt] > 0) {
      bestType = pt;
      break;
    }
  }

  // Short prompt guard (<10 words): default to "medium" not "simple" unless explicit custom weights or strong non-simple keywords
  if (wordCount < 10) {
    const nonSimpleMatches = Object.entries(counts)
      .filter(([k]) => k !== "simple" && k !== "medium")
      .reduce((sum, [, c]) => sum + c, 0);

    if (nonSimpleMatches === 0) {
      return {
        type: "medium",
        confidence: 0.3,
        signals: [],
        keywordCounts: counts,
        languageHints,
      };
    }
  }

  // Keyword density and confidence calculation
  const totalMatches = Object.values(counts).reduce((a, b) => a + b, 0);
  const density = totalMatches / Math.max(1, wordCount);
  const confidence = Math.min(
    0.95,
    Math.max(0.1, 0.1 + density * 0.4 + Math.min(0.3, wordCount * 0.03))
  );

  const matchedSignals = Object.entries(counts)
    .filter(([, c]) => c > 0)
    .map(([k]) => k);

  const resolvedType = bestType !== "medium" ? bestType : classifyPromptIntent(promptOrText);

  return {
    type: resolvedType,
    confidence: Number(confidence.toFixed(2)),
    signals: matchedSignals,
    keywordCounts: counts,
    languageHints,
  };
}
