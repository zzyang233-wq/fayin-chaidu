# 数据包来源与许可

本仓库生成的 V1 法语词形、整词发音、IPA、词性、词元及词内对应数据，来源于下列开放词汇资源。数据包与应用代码应当作为两个许可层分别理解。

## Lexique 4.00

- 作者：Boris New、Christophe Pallier、Gauvain Schalchli、Jessica Bourgin、Manuel Gimenes 等
- 项目：https://www.lexique.org/
- 数据：https://www.lexique.org/databases/Lexique400/Lexique400.tsv
- 版本：4.00（2026）
- 许可：CC BY-SA 4.0
- 许可正文：https://creativecommons.org/licenses/by-sa/4.0/
- 本次来源文件 SHA-256：`fe333b4f9e1797f23922d5863cde28635ee13685813af0f9b4b4b9f7d4610a5a`

Lexique 4 提供词形、全词 phonological representation、IPA、lemma、词性、音节和频率字段。应用不会从拼写预测整词 IPA。

## Lexique-Infra 1.11

- 作者：Manuel Gimenes、Cyril Perret、Boris New
- 项目：https://www.lexique.org/?page_id=331
- 版本化下载：https://osf.io/xenas/download
- 许可：CC BY-SA 4.0
- 许可正文：https://creativecommons.org/licenses/by-sa/4.0/
- 本次来源包 SHA-256：`d3cf11506ff572918045d8ab8c72bedcdc33c91a07c317cee05ab3f6688e5c22`

Lexique-Infra 提供 grapheme 与 phoneme association。它基于 Lexique 3.83，因此应用只发布能重新组成当前词形与 Lexique 4 全词发音的对应；版本不匹配、缺失或歧义会保留为不可解释状态。

## 再分发说明

从上述数据派生并随 V1 发布的词条和对齐数据应遵守 CC BY-SA 4.0 的署名与相同方式共享条件。规则中文说明是本项目基于逐条来源引用重新组织的内容；具体引用保存在 `data/rule_content.json`。

Wikimedia Commons / Lingua Libre 音频不属于统一许可的数据包。每个录音按其文件页分别记录许可、署名、speaker、来源页和目标 `pronunciation_id`。正式音频只从用户试听认可的 A/B speaker pool 中选择，并继续要求严格转写、唯一读音绑定、生产许可白名单和完整元数据；speaker 的代表录音审核不等同于逐文件声学听审。缺少可靠绑定或 provenance 的候选不会进入应用。

本文件是工程许可记录，不构成法律意见。仓库目前没有为应用源代码另行声明软件许可证；公开再分发代码前应先确定软件许可，并再次复核代码与 CC BY-SA 数据包的边界。
