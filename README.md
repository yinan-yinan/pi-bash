# pi-bash

`pi-bash` 是一个给 Pi 用的 Windows 扩展包，用来让 Pi 在 Windows 上优先使用 Git Bash 执行 shell 命令。

它适合这种场景：

- 你在 Windows 上使用 Pi。
- 默认 bash 后端不可用，或者会错误地走 WSL。
- 你已经安装了 Git for Windows / Git Bash。
- 你希望 Pi 能正常运行 `pwd`、`ls | head`、`git status`、`grep` 等 shell 命令。

## 安装

从 GitHub 安装：

```bash
pi install git:github.com/yinan-yinan/pi-bash@v0.1.1
```

临时试用一次：

```bash
pi -e git:github.com/yinan-yinan/pi-bash@v0.1.1
```

本地开发时，在仓库根目录运行：

```bash
pi -e .
```

或者本地安装：

```bash
pi install .
```

## 提供的工具

### `pi_bash`

Windows 下的首选 shell 命令 runner。模型仍应保留 Pi 自带能力：查目录用内置 `ls`，读文件用 `read`，改文件用 `edit` / `write`，搜索用对应搜索工具；只有需要执行 shell 命令时，才优先使用 `pi_bash`，而不是 Pi 内置的 `bash` 工具。

通过 Git Bash 执行命令：

```text
用 pi_bash 运行：pwd
```

参数：

```ts
{
  command: string;
  cwd?: string;
  timeoutMs?: number;
  bashPath?: string;
}
```

如果不传 `bashPath`，它会自动使用 Windows 的命令查找 Git Bash：

- `where.exe bash.exe`
- `where.exe git.exe`

并且会跳过 Windows 自带的 WSL shim，例如：

```text
C:\Windows\System32\bash.exe
```

### `pi_bash_find`

用于检查当前机器上 Pi 能找到哪些 Git Bash 候选路径：

```text
用 pi_bash_find 查找 Git Bash
```

## 验证

安装或临时加载后，可以依次测试：

```text
用 pi_bash 运行：pwd
```

```text
用 pi_bash 运行：echo hello
```

```text
用 pi_bash 运行：ls | head
```

```text
用 pi_bash 运行：false
```

预期结果：

- `pwd` 输出类似 `/e/pi-bash`。
- `echo hello` 输出 `hello`。
- `ls | head` 能正常显示文件列表。
- `false` 返回非零退出码，一般是 `1`。

## 说明

这个包不会替换 Pi 自带的文件工具。它只通过工具描述和 prompt 指南强提示模型：在 Windows 上需要执行 shell 命令时，优先调用 `pi_bash`，但查目录、读文件、改文件仍优先使用 Pi 内置工具。

这个包不会改写你的命令字符串，只负责找到 Git Bash 并执行：

```text
bash.exe -lc <command>
```

当前工作目录会直接传给 Node.js `spawn`，所以 Git Bash 会自动把 Windows 路径显示成类似 `/e/project` 的形式。
