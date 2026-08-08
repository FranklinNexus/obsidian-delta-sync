# Delta Sync

**一个不需要 Obsidian Sync 订阅的 Obsidian 多设备同步方案。**

Delta Sync 把 GitHub 私有仓库当作版本化传输层：电脑上的 Obsidian Vault 作为唯一
`Writer`，手机、平板和其他设备作为只读 `Follower` 自动拉取。整个过程在 Obsidian
内部完成，不需要在 Vault 中安装 Git、不需要 Syncthing 常驻，也不会把 `.git`、同步
索引或冲突文件污染到笔记目录。

## 它解决什么问题

Obsidian Sync 使用体验很好，但长期使用需要订阅；本地 Git 方案需要维护 Git 环境，
移动端操作更复杂；Syncthing 依赖两端应用持续运行，手机系统休眠后经常变成“想同步时
还要先打开应用”。Delta Sync 针对的是这三个实际成本：

- **订阅成本**：插件本身采用 MIT 许可证，不收同步服务费；使用 GitHub 私有仓库即可
  复用个人账号提供的免费额度。
- **维护成本**：没有本地 Git、没有 `.git`、没有 Syncthing 配对和后台守护进程。
- **冲突成本**：采用单 Writer 工作流。所有编辑在电脑完成，其他设备只负责拉取，远端
  版本是唯一规范来源，不生成 Git 冲突标记或 `conflicted copy`。

GitHub 仍有仓库容量、API、网络和账号规则，Delta Sync 不会绕过这些限制；对普通个人
笔记库，实际使用成本可以保持为零。

## 核心能力

### 单 Writer + 多 Follower

电脑设为 `Writer`，负责上传本地修改并推进远端分支。Android、iOS、平板或备用电脑
设为 `Pull-only follower`，只读拉取，GitHub 的只读 token 也会从权限层阻止误推送。

Follower 上意外产生的本地修改会被 Writer 的版本覆盖；被替换的文件先移入 Obsidian
回收站，便于人工恢复。这个模型明确牺牲多设备同时编辑，换取稳定、可预测的无冲突同步。

### 增量同步

- 首次同步只读取每个纳入文件一次。
- 后续通过本地索引、文件事件、修改时间和大小识别变化，未变化的文件不重复读取或哈希。
- 远端分支未变化时只做一次 HEAD 检查，不下载完整文件树。
- Follower 拉取时使用受控并发，互不依赖的文件可以并行下载。
- 文件重命名按“新建 + 删除”处理，结果与两端 Obsidian 文件树一致。

### 二进制文件与大附件

图片、PDF、Office 文件和其他二进制或大型文件会上传到 GitHub Release Assets；Git 分支
只保存小型 UTF-8 文本和隐藏索引。附件不会出现在 Vault 中的同步元数据文件里，也不会
让 Git 历史因为大文件持续膨胀。默认单文件上限为 25 MB，可调整到 GitHub 允许的最高
100 MB。

### 数据完整性与清理

- Writer 更新分支前会检查远端 HEAD，避免覆盖其他提交。
- 大批量首次同步先构造完整提交对象，再一次性推进分支，Follower 不会看到半份 Vault。
- Follower 下载后逐文件验证内容，再清理同步范围内残留的空目录。
- `.obsidian`、`.trash`、`.git`、`.agents` 等配置、回收站和排除目录受到保护，不会被
  自动清理。
- Android Vault 根目录会创建本地 `.nomedia`，避免系统相册或微信图片选择器把附件
  扫描成照片。

## 推荐配置

| 设备                       | 角色               | 权限                       | 用途                         |
| -------------------------- | ------------------ | -------------------------- | ---------------------------- |
| 电脑（E:\\Obsidian Vault） | Writer             | `Contents: Read and write` | 唯一编辑入口、上传和发布版本 |
| Samsung Android            | Pull-only follower | `Contents: Read-only`      | 查看和搜索笔记、自动拉取     |
| 其他设备                   | Pull-only follower | `Contents: Read-only`      | 查看和搜索笔记、自动拉取     |

一个 Vault 只保留一个实际目录。不要再在桌面、`Program Files` 或其他位置创建第二个
同名 Vault，也不要让 Obsidian Sync、Syncthing、iCloud、Remotely Save 等工具同时写入
同一目录。

## 安装与首次同步

1. 在每台设备安装并启用 Delta Sync。
2. 创建一个专门用于该 Vault 的 GitHub 私有仓库和分支。
3. 在电脑上选择 `Writer`，填写仓库所有者、仓库名、分支、设备名和细粒度 token；token
   只授予该仓库的 `Contents: Read and write`。
4. 在手机或其他设备选择 `Pull-only follower`，使用另一个仅有 `Contents: Read-only`
   的 token。
5. 点击 **Test connection**，再使用 **Preview** 检查首次变更，确认后执行第一次同步。
6. 打开 **Automatic sync**。插件会在 Obsidian 启动、回到前台、Writer 本地编辑停止后
   的短暂防抖期以及设定间隔执行同步；成功的自动同步保持静默，手动同步仍显示结果。

## 免费方案的成本边界

| 项目                 | Delta Sync 方案                                |
| -------------------- | ---------------------------------------------- |
| Obsidian Sync 订阅   | 不需要                                         |
| 插件费用             | MIT 开源，免费                                 |
| 传输与版本历史       | GitHub 私有仓库和 Release，使用账号可用额度    |
| 本地 Git / Syncthing | 不需要                                         |
| 需要留意的限制       | GitHub 存储、API 速率、网络和 Android 后台策略 |

GitHub 私有仓库不是端到端加密存储。敏感内容应先在 Vault 内自行加密；插件作者不会
收到文件内容、token 或遥测数据。

## 适用边界

Delta Sync 的稳定性建立在“单写入源”上：

- 它适合个人知识库、学习资料、研究笔记和附件库的电脑到移动端分发。
- 它不是多人协作合并工具，也不是实时协同编辑器。
- 同步只在 Obsidian 进程运行时执行；Android 被系统休眠或结束进程后，会在下次打开或
  回到前台时继续。
- 首次同步必须完整读取或下载一次纳入范围的文件；之后才体现增量优势。

## 隐私与排除规则

纳入同步的文件内容、路径、提交信息、仓库信息和设备名会直接发送到 GitHub API。插件
不包含遥测、广告或第三方跟踪，token 保存在 Obsidian Secret Storage，不会写入设置文件
或日志。`.obsidian`、`.trash`、`.git`、超出大小限制的文件和自定义 glob 排除规则不会
上传。

## 开发与验证

```bash
npm install
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

项目包含单元测试、发布一致性检查和真实 Android 设备验证，覆盖新建、修改、删除、
重命名、二进制文件校验和空目录清理等同步路径。

## 许可证

MIT。原始项目 [Docs Sync](https://github.com/luhaifeng666/obsidian-docs-sync) 的 MIT
许可证和版权声明继续保留。
