# Delta Sync

Delta Sync 是一个面向 Obsidian 的 GitHub 增量同步插件。它不需要在 Vault 内安装或初始化 Git，也不会创建 `.git` 目录。远端 GitHub 仓库仍保留每次同步的版本历史。

## 推荐工作流

将一台电脑作为唯一的 **Writer**，所有编辑都在这台设备完成。Writer 使用一个仅限目标仓库、拥有 `Contents: Read and write` 权限的 GitHub fine-grained token。

手机、平板与其他电脑设为 **Pull-only follower**。Follower 使用另一个仅有 `Contents: Read-only` 权限的 token，只会拉取远端内容，无法创建 GitHub 提交或更新分支。插件限制和 GitHub 令牌权限共同避免从设备误推送。

这种单 Writer 工作流不会产生 Git 冲突标记，也不会在 Vault 中留下 Git 元数据。不要在 Follower 上编辑笔记；若 Follower 上存在本地修改，插件会保留该内容为带 `sync-conflict-local` 后缀的副本，再恢复远端的规范版本，避免静默丢失内容。

## 初次配置

1. 备份 Vault，并停止 Obsidian Sync、Syncthing、iCloud、Remotely Save 等所有会写入同一个 Vault 的同步工具。
2. 创建一个专门用于此 Vault 的 GitHub 私有仓库和分支。
3. 在 Writer 的 Obsidian 设置中配置仓库所有者、仓库名、分支、设备名和读写 token。
4. 使用 **Test connection** 测试连接，使用 **Preview** 检查首次同步，再确认同步。
5. 在每台 Follower 上配置同一仓库与分支，选择 **Pull-only follower**，填入只读 token，并完成首次预览。
6. 在需要自动同步的设备上打开 **Automatic sync**。它会在启动、回到前台、Writer 本地修改停止约 10 秒后以及设定时间间隔时自动执行。

专用仓库可以保持为空。Delta Sync 会用一个真实 Vault 文件初始化仓库，再分批构造其余首次同步提交对象，最后一次性推进同步分支；其它设备不会看到半份 Vault。小型 UTF-8 笔记会在 Tree 请求中批量创建，大幅减少首次同步请求；二进制或较大的文件会并发上传到专用 GitHub Release，并在分支中只保留隐藏索引。索引不会写入 Vault，也不会在 Obsidian 中出现。

## 性能与范围

- 首次同步读取每个被纳入的文件一次；之后同步只重读被修改的文件。
- 若 GitHub 分支没有变化，远端只进行一次 HEAD 检查，不下载完整文件树。
- Follower 首次或大量拉取时，会使用 4 个受控 worker 并行下载互不依赖的文件。
- 图片、PDF、Office 文件和其他二进制或大型文件存放在 GitHub Release Assets；Git 分支只保存小型 UTF-8 文件及隐藏索引，因此 GitHub 仓库不是附件浏览入口，仍由两端 Obsidian 直接还原和使用。
- 默认最大单文件 25 MB，最高可设置为 100 MB。
- `.obsidian`、`.trash`、`.git`、超过大小限制的文件和自定义排除规则不会上传。
- 同步只在 Obsidian 打开时运行。iOS 和 Android 不保证应用完全关闭后的定时后台执行。

## 隐私

被纳入同步的文件内容、路径和提交信息会直接发送到 GitHub API。插件不包含遥测、广告或第三方跟踪。token 保存在 Obsidian Secret Storage，不会写入插件设置或日志。GitHub 私有仓库不是端到端加密。
