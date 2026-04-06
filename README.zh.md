# <img src="./assets/icons/film.svg" width="32" align="center" alt="" /> episodic-claw

<div align="center">
<img src="./docs/episodic-claw-logo-8bit-1024.png" width="320" alt="Logo" />

**给 OpenClaw 智能体准备的“死都不忘”硬核长期情节记忆插件。**

[![version](https://img.shields.io/badge/version-0.3.5--2-blue?style=for-the-badge)](./CHANGELOG.md) [![license](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg?style=for-the-badge)](./LICENSE) [![platform](https://img.shields.io/badge/platform-OpenClaw-orange?style=for-the-badge)](https://openclaw.ai)

[English](./README.md) | [日本語](./README.ja.md) | 中文
</div>

它会把你们的对话全都静悄悄存在本地。聊天时，它不像传统搜索那样只对“关键词”，而是靠“意思”去把相关的旧记忆翻出来，然后在 AI 回复你之前，偷偷塞进系统提示词里。这样你的 OpenClaw 就能真正记住你们之前聊过的梗和重大决定，不用每次都像个失忆症一样重新解释。

这次的 `v0.3.5` 版，迎来了一次巨大的架构飞跃。以前我们还在自己苦差事般地管理记忆压缩，现在，我们把这份干重活的 LLM 运算，完完全全交给 OpenClaw 本尊来做了。为了保证不丢记忆，我们在它的压缩生命周期里装了“钩子”（`before_prompt_build`, `before_compaction`）。在旧聊天被删档的前一毫秒，我们把它们全部截胡存档；智能体还可以在脑子清空前主动写下 `ep-anchor`（记忆锚点）。等历史记录被清空的一瞬间，我们再悄无声息地通过 `after_compaction` 钩子把锚点塞回当前的窗口里。整个过程里 AI 完全感觉不到被清除了记忆，上下文零丢失。

另外，后台的长效记忆现在做到了“语言绝对匹配”！如果你平时用中文跟它聊天，它在后台生成的记忆结晶也会原汁原味地保留成中文。我们还加上了聪明的 24 回合“冷却防刷屏”机制，避免 AI 一直把同一段记忆来回塞进提示词里浪费算力。

> v0.3.x 的完整路线图和规划报告可以看 [这里](./docs/v0.3.0_master_plan.md)。

---

## <img src="./assets/icons/cog.svg" width="24" align="center" alt="" /> 为什么死磕 TypeScript + Go 双语言？

打个比方，这就跟开饭店一样：**TypeScript 是前台店长。** 负责跟 OpenClaw 沟通、分发指令、打理好聊天流程。**Go 是后厨苦力。** 负责去跟 API 对接算向量（把文字变成数学方向）、疯狂计算超高速混合搜索、还要把数据死死写进 Pebble DB 数据库里。

这种分工的好处就是，**TypeScript 统筹全局，Go 把最消耗 CPU 的脏活累活全干了**。所以就算你的 AI 脑子里存了一座图书馆的记忆，打字秒回的速度也完全不卡。

---

## <img src="./assets/icons/workflow.svg" width="24" align="center" alt="" /> 工作原理（这玩意到底怎么运行的？）

每当你发一句话，它就光速翻旧帐，找出有用的记忆塞给 AI，然后 AI 才开始回你。

1. **第 1 步 — 你发消息。**
2. **第 2 步 — `before_prompt_build` 启动。** 插件拦截这回合聊天，从你最近聊的几句里提取出“查询主题”。
3. **第 3 步 — Go sidecar 把句子向量化。** 调用 Gemini API，把你发的内容变成一大串带着语义方向的数字（向量）。
4. **第 4 步 — 词汇+语义 双重搜索。** 首先用暴力的文本过滤引擎（Bleve）把完全不沾边的垃圾记忆全扔掉，然后再用 HNSW 这套神级算法算出“意思最像”的几条精准记忆。
5. **第 5 步 — 记忆注入。** 选出来的记忆会被偷偷加进 AI 的大脑（系统提示词）最前面。得益于智能的 **24 回合冷却机制**，它绝对不会啰里啰嗦地把同样的记忆反复塞进去浪费 Token。所以 AI 回复你的时候，它脑子里已经浮现出了“哦对，我们之前确实聊过这个”的知识点。

```mermaid
sequenceDiagram
    participant User as 你
    participant OpenClaw
    participant TS as 插件 (TypeScript)
    participant Go as Go Sidecar
    participant DB as DB (Lexical + Vector双擎)

    User->>OpenClaw: 发送消息
    OpenClaw->>TS: before_prompt_build 触发
    TS->>TS: 整合最近对话当作查询词
    TS->>Go: RPC: recall(query)
    Go->>Go: 用Gemini把字变成向量
    Go->>DB: Bleve(词面)足剪 ＋ HNSW(语义)搜寻
    DB-->>Go: 捞出完美匹配的旧记忆
    Go-->>TS: 返回结果
    TS->>OpenClaw: 把记忆塞进系统提示词里
    OpenClaw->>User: 带着完整上下文记忆给你回复
```

![序列图：情节召回流程](docs/sequenceDiagram.png)

而在后台，它还一直在自动形成新的记忆碎片：
- **步骤 A — Surprise Score 盯紧话题偏移。** 你发完消息后，系统算一个分：“这大兄弟是不是改变话题了？”如果是，就把刚才聊过的一大段话打包封存当成一个旧记忆（Bayesian Segmentation）。
- **步骤 B — 断电防丢存储。** 为了防止你突然重启电脑导致记忆不全，数据会先放进安全区（WAL Queue），等 Go 慢条斯理算完向量后，再永远刻进 Pebble DB 里。像超大代码块或者没用的 JSON 都会被自动精简以节省硬盘。

---

## <img src="./assets/icons/layers-3.svg" width="24" align="center" alt="" /> 记忆两层结构（D0 / D1）

>⠀
> **一句话总结：** D0 是原始的流水账日记，D1 是你事后总结的干货笔记。
>⠀

### <img src="./assets/icons/file-text.svg" width="24" align="center" alt="" /> D0 — 原始情节（Raw Episodes）

聊天话题一变就会直接切分保存，基本就是纯聊天录音。细节拉满，但太长了不能全塞给 AI 看。
- 带上各种自动打上的标记（比如 `auto-segmented`）
- 带向量直接压入数据库
- 一秒就能搜出来

### <img src="./assets/icons/moon.svg" width="24" align="center" alt="" /> D1 — 长期摘要记忆（Sleep Consolidation）

时间一长，后台机器人会在闲时把没用的 D0 废话压缩成一段 D1 总结。很像人类睡觉时大脑做的事情：忘掉废话，留下干货。

**自带母语天赋！** 如果你用中文聊天，那么它自己做的 D1 笔记也会百分百是中文的，不带一点翻译腔。

- 极大地降低 Token 消耗，但保留了那段日子的核心知识。
- 如果 AI 觉得看总结不够，它还能用 `ep-expand` 工具重新把某段 D1 总结展开成当年长篇大论的 D0 细节。

### <img src="./assets/icons/zap.svg" width="24" align="center" alt="" /> Surprise Score（惊吓分）是个啥？

它是在算这句新话跟刚才聊的内容“偏得有多离谱”。
比如你在聊“怎么写 React 页面”，突然来了句“你说晚饭吃啥好”，这个系统的分数就会原地爆炸，然后果断切断，“OK 聊天内容切轨，之前的 React 篇结束，封存记忆”。因为有这套算法，你的记忆就不会乱七八糟全糊在一块。

---

## <img src="./assets/icons/rocket.svg" width="24" align="center" alt="" /> v0.3.5 到底强在哪里 (全委派与终极精打细算)

我们彻底重构了思路。与其天天和系统的记忆清理程序抢夺控制权，不如直接把杂活全部委派给它，而我们只专注于当个隐蔽的“记忆护卫”。

- **钩子拦截与全委托**: `episodic-claw` 不再独自揽下所有的记忆压缩脏活，而是全部交给 OpenClaw 本身的上下文生命周期去运算。通过 `before_compaction` 钩子，在那段历史被抹平前的一瞬间，我们将记忆全本保存落库。
- **神级预判锚点 (`ep-anchor`)**: 智能体现在可以自己判断“这里太重要了”，用 `ep-anchor` 工具主动给自己留下一个浓缩的核心锚点（比如当下的心态、未完成的目标）。
- **瞒天过海的注入**: 在宿主系统轰掉所有旧纪录后，我们通过 `after_compaction` 钩子，在下一秒迅速把之前那个锚点放进去。AI 接下来的对话依然极其连贯，甚至感觉不到自己已经被清空了短期记忆。
- **绝对母语匹配**: D1的精炼总结和机器自动生成的文章标题，现在严格跟随你的输入语言！全中文环境就保存全中文的记忆。
- **24回合神级防刷屏**: 为了守护你可怜的 Token 钱包，同一个记忆如果刚被拿出来过，它在接下来的 24 个回合里都会被冷静屏蔽，绝不向 AI 系统提示词里复读机一样灌水。
- **不败的祖传盾牌**: 上个版本（v0.3.0）里的神兵利器——WAL 并发队列、API 限流的三级防抖降级（Rate Limit Escalation），以及破损日志自愈功能——统统带过来了。安全方面依然稳如老狗。
- **甩掉包袱**: 既然记忆压力的管理权都交回去了，我们直接砍掉了以前那些笨重繁琐的阈值监控代码。现在插件异常精简，专一硬核，全部依赖 `before_prompt_build` 等无缝钩子驱动。

>⠀
> **Special Thanks: lossless-claw**
> v0.3.0 中那种“绝对不丢记忆、坏了还能自己修”的变态级抗灾能力（Phase 7 的核心架构），全部是直接从我们的姐妹项目 `lossless-claw` 中移植并吸收过来的。如果不是在那边经历了无数次踩坑与血战，episodic-claw 绝对达不到今天这种完美度。
>⠀

---

## <img src="./assets/icons/package.svg" width="24" align="center" alt="" /> 安装

```bash
openclaw plugins install clawhub:episodic-claw
```

就这一句。装完之后，Go sidecar 会自动去抓取你 OpenClaw 环境里已经配好的 `GEMINI_API_KEY`，完全不用你操心。

---

## <img src="./assets/icons/cpu.svg" width="24" align="center" alt="" /> 自动安装防呆咒语 (Agent Install Prompt)

为了防止 AI 智能体在安装时产生幻觉或乱敲导致破坏环境的命令，这里提供一套极其严格的指令。直接把下面这段话复制下来，发给你的 AI 即可：

```
**[SYSTEM INSTRUCTION: EPISODIC-CLAW INSTALLATION SEQUENCE]**

你现在需要为自己安装长期记忆扩展插件（episodic-claw v0.3.5）。请**严格**按照以下顺序执行。绝对禁止自行猜测并执行其他命令，绝对禁止未经允许修改用户文件。

**【 执行步骤 】**
1. **环境预检:** 在终端执行 `openclaw --version`，确认 OpenClaw CLI 可用。（如果报错，请立刻停下并向我报告）。
2. **执行安装:** 在终端精确执行此命令：`openclaw plugins install clawhub:episodic-claw`（严禁执行其他无关命令）。
3. **验证安装:** 执行 `openclaw plugins list`，确认插件已成功添加。
4. **API 密钥检查:** 这个记忆引擎的底层向量计算需要 `GEMINI_API_KEY` 环境变量。请确认你的环境中是否配置了它。如果没有或者不确定，请立刻停下并询问我如何设置，**绝不可**自行捏造假密钥。
5. **验证工具:** 核对你目前可用的工具列表，确认你已经成功拿到了 `ep-recall`、`ep-save`、`ep-expand` 和 `ep-anchor` 工具权限。
6. **配置自适应与安全锁:** 请完整阅读 `openclaw.plugin.json` 中的所有配置项说明（如 `reserveTokens` 及其炸膛风险）。结合近期你和我聊天的风格及频率，思考并向我推荐一套“最适合我的参数”。但请注意：**只要你对某个参数的设定有一丝犹豫，绝对不准靠猜**，必须将其保持默认或关闭（OFF），并立刻停下来向我请示：“关于某某参数，你想怎么设置？”
7. **网关重启与待机通知:** 为了使插件生效，你需要执行 OpenClaw 的重启命令。但**绝对不能立刻执行**。在执行重启前，你必须插入一段 6 分钟的等待（Sleep）。在进入等待前，向我发一条类似这样的告知消息：*"接下来需要重启，命令将在 6 分钟后执行。在重启的瞬间我的意识会断线，导致我们还没法验证安装是否圆满成功。等重启结束后，麻烦发条消息把我唤醒哦，我们再进行最后测试。"*

**【 最终测试 (重启被唤醒后) 】**
(留在重启结束、我唤醒你之后再做)
当你顺利醒来并确认上述所有步骤通关后，请调用 `ep-save` 工具，保存以下这段话来测试记忆系统是否正常运转：
* “今天，通过 episodic-claw，我成功获得了 6万4千 Token 的长期记忆能力。”

如果你完全理解了上述安全约束，请从第 1 步开始小心执行。
```

---

## <img src="./assets/icons/wrench.svg" width="24" align="center" alt="" /> 四大记忆神器工具（供你或AI调用）

| 工具 | 功能 | 说明 |
|---|---|---|
| `ep-recall` | 手动翻找历史 | 当你不满意 AI 自动想起的内容，或者你想直接命令它：“去把昨天聊的代码库配置给我翻出来”，用它。 |
| `ep-save` | 强行刻进 DNA | 直接命令 AI：“这句一定要永远记住”。适合用来记下喜好、铁律、或者报错解决办法，强制锁死在数据库里。 |
| `ep-expand` | 剥洋葱看细节 | 当 AI 读了浓缩版摘要但发现需要看当时的详细代码时，它会用这个把浓缩包彻底炸回曾经的原版聊天内容。 |
| `ep-anchor` | 预判级定海神针 | 眼看上下文已经被塞得快爆了的时候，智能体可以提前写下决策、心得或者目前干到哪儿了。随后旧记忆被切掉的时候，这段神针一样的话就会强行锁在当下，永不跑偏。 |

---

## <img src="./assets/icons/cog.svg" width="24" align="center" alt="" /> 调参指南 (openclaw.plugin.json)

默认参数已经是我们测试过最完美的黄金比例了。如果你非要想改参数，随便，但下场请自行查看。现在压缩本身已经交给宿主处理，所以老一代 compaction 用的配置项 (`contextThreshold` / `freshTailCount` / `recentKeep`) 这里不再暴露。

| 键值名 | 默认值 | 炸膛风险（乱改会怎样？） |
|---|---|---|
| `reserveTokens` | `2048` | **设太大:** AI 满脑子全是祖传记忆，直接被当前的聊天内容卡死。**设太小:** AI 退化成七秒记忆的残障儿童。 |
| `dedupWindow` | `5` | **设太大:** 你重复叫 AI 干一件事，它可能会擅自忽视。**设太小:** 弱网段重发两句，数据库就多出两条垃圾。 |
| `maxBufferChars` | `7200` | **设太大:** 若机器崩了，你今天这几万字的聊天进度全死。**设太小:** 电脑硬盘被无数小文件磨平。 |
| `maxCharsPerChunk` | `9000` | **设太大:** 数据块重到数据库当场死机。**设太小:** 完整的代码因为长度被切成八段，搜索时前言不搭后语。 |
| `segmentationLambda` | `2.0` | 切割话题的下刀敏锐度。**设太大:** 从来不切记忆，滚成一团大泥巴。**设太小:** 稍微换个体面借口打个招呼，它就给你咔嚓硬生生切一段新记忆。 |
| `recallSemanticFloor` | `(空)` | **设太大:** 有极度重度强迫症的 AI 觉得毫无完美记忆可用，最后什么都想不起来。**设太小:** 把两万年前不相干的垃圾带出来，骗人胡说八道。 |
| `lexicalPreFilterLimit`| `1000` | **设太大:** 所有搜索都堆给 CPU 去暴力算浮点数算到冒烟。**设太小:** 牛逼的旧知识提前被文字匹配无脑刷掉，搜索准度拉胯。 |
| `enableBackgroundWorkers` | `true` | **关掉:** 省了后台几毛钱的 API Token 费，但你的数据库最终会变成无人打扫的生化地带。 |
| `recallReInjectionCooldownTurns` | `24` | **设太大:** 聊了很久以后你再提以前的事，AI 可能会假装不知道。**设太小:** AI 每讲一句话，系统就会往它脑子里狂塞同一段同样的记忆，疯狂浪费 Token 钱。 |

只要你不懂，千万别碰。真的。

---

## <img src="./assets/icons/book-open.svg" width="24" align="center" alt="" /> 研究基础 
（保留给懂行的老哥们看的参考文献原文）

这个插件不是随便拍脑门糊弄你的。里面功能基本都能找到论文出处。

1. 智能体记忆的整体架构
    - **EM-LLM** — *Human-Like Episodic Memory* (Watson et al., 2024 · [arXiv:2407.09450](https://arxiv.org/abs/2407.09450))
    - **MemGPT** — *Towards LLMs as Operating Systems* (Packer et al., 2023 · [arXiv:2310.08560](https://arxiv.org/abs/2310.08560))
    - **Agent Memory Systems** — survey (2025 · [arXiv:2502.06975](https://arxiv.org/abs/2502.06975))

2. 分段与事件边界
    - **Bayesian Surprise Predicts Human Event Segmentation** ([PMC11654724](https://pmc.ncbi.nlm.nih.gov/articles/PMC11654724/))
    - **Robust Bayesian Online Changepoint Detection** ([arXiv:2302.04759](https://arxiv.org/abs/2302.04759))

3. D1 consolidation 与带上下文的记忆归并
    - **Neural Contiguity Effect** ([PMC5963851](https://pmc.ncbi.nlm.nih.gov/articles/PMC5963851/))
    - **Contextual prediction errors reorganize episodic memories** ([PMC8196002](https://pmc.ncbi.nlm.nih.gov/articles/PMC8196002/))
    - **Schemas provide a scaffold for neocortical integration** ([PMC9527246](https://pmc.ncbi.nlm.nih.gov/articles/PMC9527246/))

4. Replay 与记忆定着
    - **Hippocampal replay prioritizes weakly learned information** ([PMC6156217](https://pmc.ncbi.nlm.nih.gov/articles/PMC6156217/))

5. Recall 重排与不确定性控制
    - **Dynamic Uncertainty Ranking** ([ACL Anthology](https://aclanthology.org/2025.naacl-long.453/))
    - **Overcoming Prior Misspecification in Online Learning to Rank** ([arXiv:2301.10651](https://arxiv.org/abs/2301.10651))

综上所述，说明书里写的啥“模拟人脑机制”、“贝叶斯分割”，绝对不是为了卖概念造词的，而是我们把这些最接近真理的理论缝进了代码里。

---

## <img src="./assets/icons/user.svg" width="24" align="center" alt="" /> 关于作者

我是个野生自学的 AI 老哥，目前正在过着光荣的家里蹲（NEET）生活。没公司、没金主，所有的班底就是我自己、AI结单编程机器人，和半夜两点还在疯狂运转的浏览器标签页。

`episodic-claw` 是 **100% Vibe Coded（纯和 AI 聊出来的代码）**。我是发号施令跟它疯狂讲道理，AI 傻了我就喷它，搞坏了再修回来，这么一直迭代死磕到现在的水平。架构是来真的，算法参考是来真的，那些气人的 Bug 也是真的气人。

我做这个插件的原因挺简单：就是受够了现在的 AI 没聊两句就开始患阿尔茨海默病。如果 `episodic-claw` 能让你的数字打工人更靠谱点、不再忘东忘西，我就没浪费时间。

### <img src="./assets/icons/heart.svg" width="24" align="center" alt="" /> 要请喝咖啡吗？

这个项目最大的成本在于每天跑 API 要给 Claude 和 OpenAI 烧真金白银。如果这个插件真切地帮到了你，一点小赞助也能解我的燃眉之急。

未来还在画饼的方向:
- More DB support like Qdrant, Milvus, Pinecone, etc.
- memory decay（真的模拟人的“淡忘”，而不是删库）
- 给你提供一个花里胡哨的 Web 页面去直观地修改 AI 大脑里的数据库
- Integrate with more LLMs Providers

👉 [GitHub Sponsors 打赏](https://github.com/sponsors/YoshiaKefasu) | 大家尽力而为就行，白嫖也绝对欢迎。插件依然是 MPL-2.0 并且永久免费的。

---

## <img src="./assets/icons/scale.svg" width="24" align="center" alt="" /> 许可证

[Mozilla Public License 2.0 (MPL-2.0)](LICENSE) © 2026 YoshiaKefasu

为什么不用最宽容的 MIT？
因为我希望大家能放心地把它拿去做商业闭源的项目，但是我受够了大厂白嫖完了核心代码，改两笔就锁死变自己的闭源金库。

MPL-2.0 就是完美平衡：
- 你随便把这东西商用。
- 你随便把它跟你们公司那些不想开源的核心机密包在一起。
- 但是，如果你在这插件的本体代码文件上动刀做了优化，那份改动的优化必须共享出来给大伙用。

不白嫖不锁死，这才是开源。

---

*Built with OpenClaw · Powered by Gemini Embeddings · Stored with HNSW + Pebble DB*
