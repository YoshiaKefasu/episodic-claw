# <img src="./assets/icons/film.svg" width="32" align="center" alt="" /> episodic-claw

<div align="center">
<img src="./docs/episodic-claw-logo-8bit-1024.png" width="320" alt="Logo" />

**给 OpenClaw 智能体准备的“死都不忘”硬核长期情节记忆插件。**

[![version](https://img.shields.io/badge/version-0.4.2--2-blue?style=for-the-badge)](./CHANGELOG.md) [![license](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg?style=for-the-badge)](./LICENSE) [![platform](https://img.shields.io/badge/platform-OpenClaw-orange?style=for-the-badge)](https://openclaw.ai)

[English](./README.md) | [日本語](./README.ja.md) | 中文
</div>

它会把你们的对话全都静悄悄存在本地。聊天时，它不像传统搜索那样只对“关键词”，而是靠“意思”去把相关的旧记忆翻出来，然后在 AI 回复你之前，偷偷塞进系统提示词里。这样你的 OpenClaw 就能真正记住你们之前聊过的梗和重大决定，不用每次都像个失忆症一样重新解释。

这次的 `v0.4.2` 版，搞了个史诗级加强的架构——**连续剧记忆法（Cache-and-Drain 架构）**！
以往如果你一次性给 AI 塞个几十万字的过去聊天记录，这破机器绝对当场卡死崩溃。现在好了，不管多海量的生肉聊天记录灌进来，通统会被丢进一个叫 `Cache DB` 的“候车区”。系统会把它稳稳地按安全的 64K 大小切好列队。然后后台打工人再去队伍里一个个认领，花时间把这些文本转化成一段段连贯的“故事剧集（Episodes）”。最屌的是，就算你电脑中途断电了，它下次开机还是会接着上次的那一集接着编下去，记忆不会断档变单集剧。

原来 v0.3 那些防丢失大招我们都原封不动保留了：母语原味生成、防重复洗版的 24 回合冷却、还有赶在记忆被系统强制清除前那 1 毫秒极限续命的 Ninja Hook 都在。

> 想要看我们 `v0.4.x` 怎么一步步进化来的，去 [这里](./docs/plans/v0.4.0_narrative_architecture_roadmap.md) 看大纲。

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

而在后台，它还一直在自动形成新的记忆碎片（这就是v0.4.2的绝活）：
- **步骤 A — 全丢进 Cache DB 候车区。** 海量的聊天日志倾泻下来时，系统不会慌，会把它果断切分成安全的 64K 小块，然后乖乖让它们去队列排队。就算遇到大浪冲击，接口也不会崩溃。
- **步骤 B — 排队拍连续剧。** 后台的爬虫会一个个取走候车区的块子，利用刚才上一集的提示词，把它变成这一集连击不断的故事。最后安稳地落进 Pebble 数据库里，以后你怎么搜都搜得到。

---

## <img src="./assets/icons/layers-3.svg" width="24" align="center" alt="" /> 连续剧情节记忆结构

到了 v0.4.2 这个版本，你再也不用去头疼什么“记忆分层”或者“压缩总结”这种复杂的底层设计了。你只需要记住：**所有的满天飞的草稿聊天，最后都会变成一段连贯的剧集（Episodes）。**

- **排队生成:** Cache DB 会把文本安全分块，然后它们带着上下文的连贯记忆，被一段段送进 Pebble DB 里做成永远忘不掉的一集集剧情。
- **自带母语天赋！** 如果你用中文聊天，那么它后台的总结笔记也绝对是全中文的，不带一点翻译腔。

### <img src="./assets/icons/zap.svg" width="24" align="center" alt="" /> Surprise Score（惊吓分）是个啥？

它是在算这句新话跟刚才聊的内容“偏得有多离谱”。
比如你在聊“怎么写 React 页面”，突然来了句“你说晚饭吃啥好”，这个系统的分数就会原地爆炸，然后果断切断，“OK 聊天内容切轨，之前的 React 篇结束，封存记忆”。因为有这套算法，你的记忆就不会乱七八糟全糊在一块。

---

## <img src="./assets/icons/rocket.svg" width="24" align="center" alt="" /> v0.4.x 到底强在哪里 (永远挤不爆的记忆队列)

我们受够了塞一堆过去的代码让 AI 读，结果它报错说超出了上下文或者请求撞墙。我们也受够了一重启机器，连续剧的上下文就断线变成了单集片段。这是痛痒级别的重构。

- **死不撞墙的 Cache 候车室**: 你一次性导入几十万字的老剧本，放心，现在的系统会稳稳当当接盘，安全切成一段段丢进 Cache 临时排队，绝不再爆出 400 Bad Request。
- **再开机进度不断档 (Per-Agent Continuity)**: 如果程序处理故事途中挂了，别急，重启后再也不用从零开始。它会记得刚才针对你的 AI 那集演到哪了，无缝衔接接着编下去。
- **指数级退让，疯狂续命**: 当 OpenRouter 或者其他大模型 API 给咱们抛 429 频率超额报错时，不慌！系统会自动等 5 秒，再等 10 秒……直到成功，不会让你好不容易聊出的干货就这么飘散在风里。
- **钩子拦截与全委托**: 旧版自己笨重做记忆摘要的老路子彻底抛弃了。我们全丢给 OpenClaw。但是我们设了 `before_compaction` 这个神钩子。就在宿主准备强行清空上下文记录的死线那一毫秒，拦截！再把旧记忆平妥妥转移。数据依然不会有1%的流失。
- **绝对母语匹配**: 机器自动生成的连续剧情和文章标题，严格跟随你的输入语言！全中文环境就保存全中文的记忆。

> (**Special Thanks: lossless-claw**) 这种“把不死做到极致、崩了就自己退让续命”的逆天操作理念，直接从我们的姐妹项目 `lossless-claw` 中移植过来。没有那边的血泪试毒打怪之路，哪有现在坚如磐石的 episodic-claw。

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

你现在需要为自己安装长期记忆扩展插件（episodic-claw v0.4.2）。请**严格**按照以下顺序执行。绝对禁止自行猜测并执行其他命令，绝对禁止未经允许修改用户文件。

**【 执行步骤 】**
1. **环境预检:** 在终端执行 `openclaw --version`，确认 OpenClaw CLI 可用。（如果报错，请立刻停下并向我报告）。
2. **执行安装:** 在终端精确执行此命令：`openclaw plugins install clawhub:episodic-claw`（严禁执行其他无关命令）。
3. **验证安装:** 执行 `openclaw plugins list`，确认插件已成功添加。
4. **API 密钥检查:** 这个记忆引擎的底层向量计算需要 `GEMINI_API_KEY` 环境变量。请确认你的环境中是否配置了它。如果没有或者不确定，请立刻停下并询问我如何设置，**绝不可**自行捏造假密钥。
5. **验证工具:** 核贴你目前可用的工具列表，确认你已经成功拿到了 `ep-recall`、`ep-save`、`ep-expand` 和 `ep-anchor` 工具权限。
6. **配置自适应与安全锁:** 请完整阅读 `openclaw.plugin.json` 中的所有配置项说明（如 `reserveTokens` 及其炸膛风险）。结合近期你和我聊天的风格及频率，思考并向我推荐一套“最适合我的参数”。但请注意：**只要你对某个参数的设定有一丝犹豫，绝对不准靠猜**，必须将其保持默认或关闭（OFF），并立刻停下来向我请示：“关于某某参数，你想怎么设置？”
7. **网关重启与待机通知:** 为了使插件生效，你需要执行 OpenClaw 的重启命令。但**绝对不能立刻执行**。在执行重启前，你必须插入一段 6 分钟的等待（Sleep）。在进入等待前，向我发一条类似这样的告知消息：*"接下来需要重启，命令将在 6 分钟后执行。在重启的瞬间我的意识会短暂断线，导致没法立刻验证是不是全装好了。等重启结束后，随便发条消息把我叫醒哦。"*

**【 最终测试 (重启被唤醒后) 】**
(留在重启结束、我唤醒你之后再做)
当你顺利醒来并确认上述所有步骤通关后，请调用 `ep-save` 工具，保存以下这段话来测试记忆系统是否正常运转：
* “今天，通过 episodic-claw，我成功斩获了 64K 量级的铁壁连续剧记忆架构。”

如果你完全理解了上述安全约束，请从第 1 步开始小心执行。
```

---

## <img src="./assets/icons/wrench.svg" width="24" align="center" alt="" /> 四大记忆神器工具（供你或AI调用）

| 工具 | 功能 | 说明 |
|---|---|---|
| `ep-recall` | 手动翻找历史 | 当你不满意 AI 自动想起的内容，或者你想直接命令它：“去把昨天聊的代码库配置给我翻出来”，用它。 |
| `ep-save` | 强行刻进 DNA | 直接命令 AI：“这句一定要永远记住”。适合用来记下喜好、铁律、或者报错解决办法，强制锁死在数据库里。 |
| `ep-expand` | 剥洋葱看细节 | 当 AI 觉得“光看摘要这段连续剧我还不够清楚”时，它会用这个工具去调取出当时最原始、最细节的长篇大论。 |
| `ep-anchor` | 预判级定海神针 | 眼看上下文已经被塞得快爆了的时候，智能体可以提前写下决策、心得或者目前干到哪儿了。随后旧记忆被切掉的时候，这段神针一样的话就会强行锁在当下，永不跑偏。 |

---

## <img src="./assets/icons/cog.svg" width="24" align="center" alt="" /> 调参指南 (openclaw.plugin.json)

默认参数已经是我们测试过最完美的黄金比例了。
*注意：像 `maxBufferChars` 或 `maxPoolChars` 这种旧设定的硬参数在引擎盖底下确实还留着（为了兼容性），但它们已经被降级为“进阶/旧版专用（Advanced/Legacy）”了。日常玩家根本不用碰它们。*

| 键值名 | 默认值 | 炸膛风险（乱改会怎样？） |
|---|---|---|
| `reserveTokens` | `2048` | **设太大:** AI 满脑子全是祖传记忆，直接被当前的聊天内容卡死。**设太小:** AI 退化成七秒记忆的残障儿童。 |
| `dedupWindow` | `5` | **设太大:** 你重复叫 AI 干一件事，它可能会擅自忽视。**设太小:** 弱网段重发两句，数据库就多出两条垃圾。 |
| `maxBufferChars` | `7200` | **[Advanced]** 现场实时处理时，不等话题自然偏移就强行把缓存截断塞进 Cache 的封顶大闸。 |
| `maxPoolChars` | `15000` | **[Advanced]** 连续剧情节池的狂暴泄洪阀门。只要池子文字超过这个数，强子就立刻发车去干活编剧本。 |
| `maxCharsPerChunk` | `9000` | **[Legacy]** 上个世纪遗留的 `chunkAndIngest` 旧版老古董兼容参数，新版连续剧系统鸟都不鸟它。 |
| `segmentationLambda` | `2.0` | 切割话题的下刀敏锐度。**设太大:** 从来不切记忆，滚成一团大泥巴。**设太小:** 稍微换个体面借口打个招呼，它就给你咔嚓硬生生切一段新记忆。 |
| `recallSemanticFloor` | `(空)` | **设太大:** 有极度重度强迫症的 AI 觉得毫无完美记忆可用，最后什么都想不起来。**设太小:** 把两万年前不相干的垃圾带出来，骗人胡说八道。 |
| `lexicalPreFilterLimit`| `1000` | **设太大:** 所有搜索都堆给 CPU 去暴力算浮点数算到冒烟。**设太小:** 牛逼的旧知识提前被文字匹配无脑刷掉，搜索准度拉胯。 |
| `enableBackgroundWorkers` | `true` | 后台静默干活兼老数据兼容的兜底护城河。**关掉:** 能省几毛钱 API 费，但旧版的垃圾资料会把你数据库糊住，新的后台优化也不做了。 |
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

3. 连续剧集化（Narrative Consolidation）与带上下文的记忆归并
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
