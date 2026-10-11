# 问题分析：overview 过渡的非线性（gnome-shell#2968）

> 本文记录旧的 `engine: transform` 方案及历史测试。默认实现现已改为直接分配
> 原生过渡布局，见 [native-layout.md](native-layout.md)。本文的 0.01 px 数据
> 不适用于新实现；新实现会受到 Clutter 内容分配的像素取整影响。

本文记录这个扩展要解决什么、为什么上游现在还没解决、以及本扩展用什么办法
把它绕过去，附实测数据与踩过的坑。上游可移植的方案见 [upstream.md](upstream.md)。

## 1. 结论摘要

- 症状：按 Super 进入 overview 时，窗口预览会「先缩一下再长回来」，中心走的是
  弧线而不是直线。**开出方向偏差 13–21 px，关闭方向 0.6–5 px**（1280×800，
  单窗口，最小二乘拟合 vs `t`）。
- 机理：屏幕上的几何 = **两层嵌套的线性插值**（overview 容器缩放/平移 ∘
  workspace 内部窗口浮动↔槽位插值），同一个 `t` 用两次 → 关于 `t` 是二次的；
  2020 年为压制「尺寸先缩后涨」加的 `Math.max()` 又把它变成分段函数。
- 上游现状（2026-10）：issue 仍 open；!4010 与 !4035 都还开着，前者被
  skeller 判定「没有解决根本问题」，后者自己也承认解决不了全部非线性。
- 本扩展的做法：**不复刻公式**，而是采样两个稳态（会话态 = 窗口真实 frame
  rect；picker 稳态 = shell 自己算出来的结果），把每个 preview 钉在二者的线性
  插值上。修复后的路径与端点误差均在 **0.01 px** 内。picker 稳态沿用 shell
  布局；关闭时在可见的 `t=0` 仍保持修正，直到真实窗口接管。

## 2. 机理

### 2.1 两层 lerp

进入 overview 时，控件状态值 `t`（`OverviewControls.ControlsState`，0 =
HIDDEN，1 = WINDOW_PICKER）同时驱动：

1. **外层**：`ControlsManagerLayout` 用 `getStateTransitionParams().progress`
   把 workspace 的 box 从整个工作区插值到 picker 的 box
   （`overviewControls.js:_computeWorkspacesBoxForState` + `interpolate`）；
   `WorkspacesView.vfunc_allocate` 再把 workspace actor 放进
   `fitSingleBox.interpolate(fitAllBox, fitMode)`。
2. **内层**：`WorkspaceLayout._stateAdjustment` 由 `workspacesView.js:258`
   直接赋成 `workspaceMode = lerp(mode(initial), mode(final), progress)`，
   对 HIDDEN↔WINDOW_PICKER 就是 `progress`；这个值在
   `vfunc_allocate` 里用于 `Util.lerp(workspaceBox, slot, t)`。

两层 linear 复合出 quadratic，skeller 在 issue #2968 的 note 878605/878622
里给了完整推导（在他 2020-07-30 的评论里还给了 500px → 400px → 350px → 500px
的数值例子）。同时因为 workspace 的分配在动画期间被缩小/下移，**桌面（浮动）
布局的参考系本身在动**——这正是 2020 年 fmuellner 与 skeller 争的那一点：
fmuellner 认为 floating layout 应当「相对父级」，而要让过渡线性又需要绝对
坐标，两者互斥。

### 2.2 `Math.max()` 的分段

2020-09 的 `7f402c1c`（"workspace: Cap scaled floating size to target layout
size"）为了压制「尺寸先缩后涨」加了：

```js
if (inSessionTransition) {
    workspaceBoxWidth = Math.max(workspaceBoxWidth, width);
    workspaceBoxHeight = Math.max(workspaceBoxHeight, height);
}
```

它只把**起点**抬到目标尺寸，于是对那些「本来就以真实尺寸进入 overview」的
窗口，尺寸在整段过渡里被钉成常数、位置却在插值——这既是 issue 里
「should not change size」那类窗口看起来最别扭的原因，也是为什么 !4010 把它
当成主攻对象。

### 2.3 开出与关出不对称

实测里关闭方向的原始非线性只有 0.6–4.8 px，原因是
`Workspace.prepareToLeaveOverview()` 会把 `layout_frozen` 置真，离开 overview
期间 `_windowSlots` 不再重算，只按 `slotsScale = box.width / _windowSlotsBox.width`
等比缩放，于是「目标」在容器坐标系里是稳定的，复合出的曲线反而接近直线。
开出方向没有这层保护（布局每帧按当前 box 重算），所以最难看。

## 3. 本扩展的对策

### 3.1 不变量

对每个 preview，过渡期间屏幕上显示的 box 必须等于：

```
screenBox(t) = lerp(sessionBox, pickerBox, t)
```

- `sessionBox`：窗口真实 frame rect。`WindowPreview.boundingBox` 来自
  `ShellWindowPreviewLayout`，由 `meta_window_get_frame_rect()` 并集而成，
  是 **stage 坐标**。冻结槽位产生的 `t == 0` 分配可能比这个真实 frame 大，
  不能直接把 shell 的关闭末帧当成正确目标。
- `pickerBox`：**测量**出来的。在 `t == 1`、overview 可见且布局未冻结时，
  记住 shell 自己分配出来的普通槽位。关闭前另存当前显示的窗口内容盒，
  包含悬停放大；即使刚移除窗口导致布局冻结，也能从这个实际显示盒退出。

picker 稳态不施加修正。关闭修正必须贯穿可见的 `t = 0`，在 `hidden` 信号
到达后才恢复原始变换，否则动画结束时会露出过大的冻结分配并发生跳变。
退出作用范围、拖拽与禁用扩展时也恢复完整的 pivot、scale 和 translation。

### 3.2 修正方式

不走 `child.allocate()`（会和布局管理器打架），而是在原始分配**之后**给
preview 加一个纯变换。先保存并中和外层变换，再测量内部 `window_container`
的局部内容盒 `base`，这样悬停缩放产生的尺寸和原点变化也被纳入：

```js
preview.set_pivot_point(0, 0);
const sx = local.width / base.width;
const sy = local.height / base.height;
preview.set_scale(sx, sy);
preview.translation_x = local.x - allocation.x1 - (base.x - allocation.x1) * sx;
preview.translation_y = local.y - allocation.y1 - (base.y - allocation.y1) * sy;
```

pivot 放左上角是关键：Clutter 的 `:translation-*` 作用在**父坐标系**且不参与
自身缩放（顺序见 `clutter_actor_real_apply_transform()`）。局部目标通过容器
自身和祖先的完整变换求逆得到，平移量再扣除缩放后的内部内容偏移。

### 3.3 为什么不用复刻公式

另一种做法是把 `vfunc_allocate` 的数学抄进扩展做「预补偿」。数学上可解，但
`Math.max` 分支、`slotsScale`、`WINDOW_PREVIEW_MAXIMUM_SCALE` 封顶都要逐字
复刻，上游一改就静默坏掉。端点采样法的正确性来自「测得的就是 shell 的结果」，
与具体插值公式无关，减少了对上游数学实现的依赖。但生命周期、私有 API 和
actor 层级仍可能改变；每个新 Shell 版本都需要回归验证。

## 4. 实测

命令（细节见 [../tests/README.md](../tests/README.md)）：

```sh
tests/run-tests.sh                              # 修正开启，期望线性
ENABLED=0 EXPECT=nonlinear tests/run-tests.sh   # 对照组，期望非线性
```

判据：把每个单调段（开出/关出各自成段）的 `x, y, width, height` 对 `t` 做最小
二乘直线拟合，取最大残差。对 `t` 拟合而非对时间拟合，因此 easing 被消掉。

历史数据（嵌套 GNOME Shell 50.4，1280×800，主机 GNOME 50.5）：

| 用例 | 段 | 残差（本扩展） | 残差（stock） | 长宽比漂移 |
|---|---|---|---|---|
| 单窗口 0.46×0.42 | 开出 | **0.01 px** | 16.3 – 20.8 px | 0.00 % |
| 单窗口 | 关出 | **0.01 px** | 0.68 – 0.86 px | 0.00 – 0.01 % |
| 双窗口 | 开出 | **0.01 px** | 13.3 – 16.7 px | 0.00 % |
| 双窗口 | 关出 | **0.01 px** | 4.2 – 5.3 px | 0.00 – 0.01 % |

（数值区间来自多次运行；单次运行的完整逐段数据见 `KEEP=1` 保留的
`shell.log`。）

对照组（`enabled: false`）断言「测量确实能发现 stock 的非线性」：
单窗口 ≈18.6 px、双窗口 ≈19.5 px（多次运行在 18–20 px 之间），远高于 3 px 阈值。这就是「用旧代码验证测试会失败」
这条约定的形式化版本。

`0.01 px` 量级只是浮点/取整噪声——修正后的几何是 `t` 的精确线性函数。

历史测试只拟合中间路径，没有验证路径终点。错误的目标也能生成完美直线，
所以以上数值不能证明关闭交接正确。修复后的测试同时检查每段路径外推到
`t=0/1` 的端点与真实 frame、picker 盒一致；单元测试还直接验证可见的 `t=0`
与接近零的帧之间没有跳变。

2026-10-11 的 GNOME Shell 50.5 headless 回归（1280×800，软件渲染）全部通过：

| 场景 | 修正路径最大残差 | 外推端点最大误差 |
|---|---|---|
| 单窗口、双窗口 | 0.01 px | 0.00 px |
| 悬停后退出 | 0.01 px | 0.00 px |
| 关闭另一个窗口后立即悬停退出 | 0.01 px | 0.00 px |

禁用对照最大残差为 22.30 px；九个单元回归全部通过，覆盖端点、坐标变换、
工作区间的记录隔离、布局重建后的缓存保留及完整变换恢复。

## 5. 为什么可以做成扩展（并且必须走 InjectionManager）

`GObject.registerClass` 在**注册时**就把 `vfunc_*` 方法包成
`GjsCallbackTrampoline` 写进 C vtable（`gjs/gi/object.cpp:3838-3854`，
`gjs/modules/core/overrides/GObject.js:297-305`），所以：

```js
WorkspaceLayout.prototype.vfunc_allocate = fn;   // ❌ 无效，Clutter 仍调旧函数
```

而 GNOME Shell 的 `InjectionManager` 对 `vfunc_` 前缀有专门分支，会重新
`hook_up_vfunc`，覆盖那个 class 自己的 vtable 槽
（`js/extensions/extension.js:89-97`）：

```js
this._injections.overrideMethod(WorkspaceLayout.prototype, 'vfunc_allocate', original =>
    function (container, box) {
        original.call(this, container, box);   // 让 shell 照常算
        corrector.apply(this, container, box); // 再把它掰直
    });
```

补充：`_saveMethod()` 保存的是原型上的原始 JS 方法（原型从未被改），所以
`clear()` 能干净地、可重复地还原。另外 `WorkspaceLayout` 还有个内部子类
（`screenshot.js: UIWindowSelectorLayout`），GType 的子类 class struct 是父类
class struct 的拷贝，所以我们的覆盖只影响 `WorkspaceLayout` 自己的实例
（正是窗口选择器用的那些），不会波及截图 UI。

## 6. 踩过的坑（都是导致过错误结论或错误实现的）

1. **preview 和 layout 都不是稳定身份**：Shell 每次隐藏概览都会重建视图。
   端点必须按 **workspace 身份、monitor index、meta window id** 保存；
   同一个窗口在不同布局上的槽位也不能互相覆盖。
2. **`t == 1` 不等于「picker 几何已稳定」**：缩略图区的 `expandFraction` 是
   另一条 250 ms 时间线，容器 box 还在动；此时采样会得到一个长宽比都不对的
   中间盒（实测 492×340 vs 窗口 589×336）。修正：只在布局未冻结、overview
   可见时采样，并且定期覆盖。
3. **overview 隐藏时 `t` 保持旧值**：控件状态调整在隐藏时不复位，所以启动
   阶段（overview 未显示、`t = 1`）如果采样，会存下一个错误的「目标」。必须
   加 `Main.overview.visible` 判断。
4. **`layout_frozen` 期间不能采样**：`_doRemoveWindow()` 会冻结布局 750 ms，
   冻结期间的槽位属于旧的窗口组合；采下来会在解冻后变成过期目标（实测表现为
   关闭方向出现 17.9 % 的长宽比漂移）。
5. **窗口在 overview 关闭期间被移动/缩放**后，旧端点是错的：比较所有窗口
   的位置和尺寸、窗口组合、显示器、workarea、workspace count 与布局参数。
   上下文变化就丢弃缓存，第一次开出退回 shell，关闭仍使用当前显示快照。
6. **不要碰 shell 自己在动画的 preview**：新窗口入场有 250 ms 的
   `scale_x/y` ease（`Workspace._doAddWindow`），拖拽/DND 会写 translation，
   布局变化的 `animateAllocation` 也自带 transition。这些 preview 必须跳过。
7. **app grid 必须排除**：picker↔app grid 时窗口本来就该随 workspace 一起缩小，
   硬掰会破坏小工作区缩略图的效果（!4010 的 `stateAdjustementValue > 0` 判断
   在这一点上是相同的）。
8. **不能用当前 layout 的窗口集合清理全局记录**：空工作区会把其他工作区
   的修正记录误删，却没有恢复 actor 变换，造成 picker 位置持续偏移。
9. **外层分配不等于窗口内容几何**：悬停放大作用在内部内容 actor。只按外层
   allocation 缩放会重复放大，尺寸和位置都错；必须修正内容盒。

## 7. 尚未覆盖 / 未验证

- **非活动 workspace**：其浮动位置带有 workspace 滚动偏移，扩展默认不处理
  （`scope: active-workspace`）。!4035 讨论里 skeller 也建议用
  `this._metaWorkspace.active` 限定。
- **容器自身的曲线**：workspace 背景、dash、搜索框仍走 shell 的曲线；本扩展
  只修 preview。
- **`_adjustSpacingAndPadding()`**：靠近屏幕底部时会给 workspace 让出标签空间，
  过渡中途条件翻转 → 一次竖直轻微位移。本扩展的修正覆盖了它的**末端**影响
  （目标取自最终态），但没修它本身。
- **HiDPI / 多显示器 / 不同工作区布局**：测试脚本支持环境变量指定容器，但尚未
  在非整数缩放、多显示器、workspaces-only-on-primary=false 组合下跑过。
- **扩展自身的代价**：每次 allocation 计算布局签名并测量窗口；过渡时还需
  做变换和属性写入。稳定态也有采样成本，尚未做大窗口数量的性能测量。
