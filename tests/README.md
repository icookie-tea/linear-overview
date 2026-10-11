# 行为测试（嵌套 GNOME Shell）

这些测试回答一个问题：**过渡期间窗口 preview 的屏幕几何是不是 `t` 的线性
函数？** 它跨 250 ms 的动画发生，手动看录像只能得到"感觉"，所以测试在 toolbox
容器里的一个嵌套 GNOME Shell（`gnome-shell --devkit`）中自动跑，并对每帧几何
做最小二乘拟合。

## 断言

`nested/automation.js` 在 shell 启动后运行，覆盖两个用例（单窗口 / 双窗口）：

| 断言 | 条件 |
|---|---|
| 端点不被修改 | `t == 0`（会话态）与 `t == 1`（picker 稳态）下，修正前后的几何完全一致，且没有任何帧应用了修正 |
| 路径线性 | 每个单调段（开出/关出各自成段），`x, y, width, height` 对 `t` 的最小二乘拟合残差 ≤ 1.5 px |
| 长宽比不变 | 段内 `width/height` 的相对漂移 ≤ 0.5 % |
| 对照可发现 | `EXPECT=nonlinear` 时，至少一段的残差 ≥ 3 px（证明测的是真东西） |

对 **`t`** 而不是时间做拟合，所以 easing（`EASE_OUT_SINE` 等）被消掉——线性
与否只取决于几何，不取决于时间曲线。

## 运行

```sh
tests/run-tests.sh                              # 修正开启，期望线性
ENABLED=0 EXPECT=nonlinear tests/run-tests.sh   # 对照组，期望非线性
KEEP=1 tests/run-tests.sh                       # 保留日志与临时 HOME
```

环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CONTAINER` | `fedora-toolbox-44` | toolbox 容器名 |
| `WORKDIR` | `/tmp/linear-overview-tests` | 容器可见的临时目录 |
| `ENABLED` | `1` | 写入扩展 `dev-config.json` 的 `enabled` |
| `EXPECT` | `linear` | `linear` / `nonlinear`，决定哪条断言才算通过 |
| `KEEP` | `0` | `1` 保留日志与 `/tmp/linear-overview-tests/home` |

前置条件：

- 在一个有图形会话的终端里运行（嵌套 shell 会通过 `mutter-devkit` 在宿主机上
  显示一个窗口）
- 容器里要有 `gnome-shell >= 50`（`--devkit`）、`gjs`、GTK4、
  `/usr/libexec/mutter-devkit`

## ⚠️ dconf 隔离

**dconf 走的是会话总线，不是 `$HOME`。** 一条

```bash
dconf write /org/gnome/shell/enabled-extensions "['...']"
```

写到的是**正在使用的桌面环境**的设置，而不是测试目录。因此所有 dconf 操作都像
`nested/dconf-setup.sh` 那样：

```bash
env HOME="$TESTHOME" LO_TEST_HOME="$TESTHOME" \
    dbus-run-session -- bash dconf-setup.sh
```

`dconf-setup.sh` 自带守卫：要求 `HOME == LO_TEST_HOME`，并且拒绝在
`unix:path=$XDG_RUNTIME_DIR/bus`（真机会话总线）上运行。

## 用旧行为验证测试会失败

```bash
ENABLED=0 EXPECT=nonlinear tests/run-tests.sh
```

应当 **ALL PASS**（含义是"测量确实发现了 stock 的非线性"），日志里能看到
单窗口 ≈18.6 px、双窗口 ≈19.5 px 的最差残差（多次运行在 18–20 px 之间）；而 `EXPECT=linear` 时这些用例必须
失败。这一对组合就是"测试没有骗人"的证据。

## 读日志

`KEEP=1` 后看 `/tmp/linear-overview-tests/shell.log`：

- `[LO-TEST] INFO xxx: notes {...}`：过渡帧的修正状态计数。理想值是
  `{"corrected": N}`；出现 `no-picker` 表示该窗口没有可用的 picker 端点
  （新窗口、刚被缩放、布局冻结），出现 `busy` 表示 shell 正在自己动画这个
  preview。
- 每个 run 一行残差：`residual=…px (shell alone: …px)`，第二个数字是**同一批帧
  里原始（未修正）几何的残差**，直接给出对照。
- 前两个 run 会打印逐帧转储
  `[t, note, 记录号, picker 盒, session 盒, 显示盒]`，用来定位端点错误。
- `stats` 里的 `sample` / `dropSession` / `dropAge` / `frozen` / `hidden`
  计数说明采样与丢弃的原因。

## 已知的测试环境抖动

嵌套 mutter 在窗口更换 workspace 之后偶尔会把 overview 卡在动画中途
（`t` 停在 0，`animationInProgress` 为真）。这是**测试环境问题，不是被测行为**：
`cycleOrSkip()` 会记录并尝试恢复，然后跳过该轮的剩余循环、用已有帧继续分析。
日志里出现 `cycle aborted:` 不代表失败。

另外，崩溃过的嵌套 shell 会留下自己的 Wayland socket，下一个嵌套 shell 会
**复用同一个名字**，于是"新 display"检测不到——`harness.sh` 因此会先清理
没人监听（连接失败）的 socket，并且只接受能成功连接的候选。
