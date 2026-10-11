# 把这里学到的搬回上游（草案）

> 本文是早期 transform 试验的上游讨论草案。当前扩展已实现直接分配的布局
> 分支，见 [native-layout.md](native-layout.md)。下方早期伪代码里的端点恒等
> 判断不能作为关闭交接的正确实现，必须保证可见零端点等于真实窗口 frame。

本扩展是试验台，不是修复。本文把它验证过的结论整理成**可以直接落到
gnome-shell 仓库**的形式，供将来开 MR（建议基于
[!4035](https://gitlab.gnome.org/GNOME/gnome-shell/-/merge_requests/4035)）
或作为 issue #2968 的评论使用。

## 0. 一句话

> 过渡期间，每个窗口 preview 在**屏幕坐标**里的 box 必须是它两个稳态几何的
> 线性插值；任何「端点自身也在动」或「对插值结果做非线性操作」的写法都会破坏
> 这一点。

实测（本仓库 `tests/`，嵌套 GNOME Shell 50.4）：stock 开出方向偏离直线
13–21 px，关闭方向 0.6–5 px；按此不变量实现后两者都是 0.01 px。

## 1. 上游现状（2026-10）

- issue #2968 仍 open。2020 年 skeller 的诊断（note 878605 / 878622）指出两层
  lerp 复合；fmuellner 回复 floating layout 有意「相对父级」（为了能复用到
  workspace 缩略图），两者互斥，于是当年只加了 `7f402c1c` 的
  `Math.max()` 兜底并关闭不了 issue。
- **!4010**（`TheEvilSkeleton/straight-unlike-me`）：把 `Math.max()` 换成「插值
  窗口尺寸 + 平移原点」，并删掉 `prepareToLeaveOverview()` 里的
  `layout_frozen = true`。skeller 的评审要点：没有解决两层 lerp；`0367edb9`
  那段补宽度的数学只对最大化窗口成立；`d01a0ea3` 实际 revert 了 2014 年的
  `4bb2a364d3`；删除 `layout_frozen` 应该改在 `prepareToLeaveOverview()`
  里不设，而不是删 vfunc 里的 override。作者 2026-04 想合并，被 fmuellner
  与 skeller 拦下，现 `need_rebase`。
- **!4035**（skeller，`less-overview-nonlinearity`）：两个 commit
  （`b0ff7e81` 容器尺寸变化时始终重算 slots、`90ffd39e` 过渡期间不缩放窗口，
  并对未缩放窗口做居中补偿），去掉了 `Math.max()` 与 `slotsScale`。
  作者自己注明**仍不能关闭 #2968**。

## 2. 建议的实现路径

### 2.1 以 !4035 为骨架

它的方向是「删掉非线性来源」而不是「往数字里塞 padding」，评审成本更低，
且 skeller 是 issue 的诊断者——用他自己的标准（linear in screen space）表述
方案，接受度最高。

### 2.2 补上「端点固定」这一条

!4035 解决了**尺寸**被容器缩放二次相乘的问题，但浮动端点仍然是
`(boundingBox - workarea) * allocationScale`，即它随容器一起动。只要端点在
动，`lerp(端点(t), 目标, t)` 依然不是 `t` 的线性函数。两个可选的收敛方式：

**A. 冻结端点（改动最小）**
在过渡开始时（`getStateTransitionParams().transitioning` 由 false 变 true）
把 `_windowSlotsBox` / 最终目标的几何快照一次，整个过渡期间只做：

```js
const wanted = Util.lerp(sessionBox, pickerBox, t);   // 两端都固定
```

配合 !4035 的「过渡期间不缩放窗口」，这就是完整的不变量。

**B. 保持相对坐标但在容器变换之后做修正（更通用）**
`vfunc_allocate` 里仍然算 `childBox`，但把 `allocationScale` 从端点里挪到
**结果**上，并且用容器当前变换的逆把「屏幕目标」转回局部坐标：

```js
const [ox, oy] = container.get_transformed_position();       // 容器局部原点（stage）
const k = containerAccumulatedScale(container);              // 一般等于 1
const local = {
    x: (want.x - ox) / k, y: (want.y - oy) / k,
    width: want.width / k, height: want.height / k,
};
```

要点是**除法**（逆变换），不是乘法：`Math.max()` 那类补丁之所以越长越乱，
就是因为它在用乘法去模拟逆变换。

### 2.3 不要做的事

- 不要在 `vfunc_allocate` 里对插值**结果**再做任何非线性操作（`Math.max`、
  按轴 clamp、`Math.floor` 之外的对齐、逐轴不同的 scale）。这些正是现状里
  「先缩后涨」与长宽比漂移的来源。
- 不要把 workspace 缩略图的需求混进来：缩略图要的是「相对父级的浮动布局」，
  而过渡动画要的是「屏幕绝对几何」。两者应该由**不同的入口**提供
  （例如 layout manager 增加一个「目标是否稳定」的开关，而不是让同一个公式
  兼顾两者）。

## 3. 可移植的代码草案（基于 `main` / !4035 的骨架）

```js
// workspace.js, WorkspaceLayout.vfunc_allocate()
// 端点：会话态的窗口几何（stage 坐标，来自 preview.boundingBox）
//       目标态几何（在同一容器状态下测量/缓存；过渡期间冻结）
const t = this._stateAdjustment.value;
const session = child.boundingBox;          // stage
const target = this._frozenTargets?.get(child) ?? null;

if (!target || t <= 0 || t >= 1) {
    // 稳态：完全交给原有路径（端点恒等）
    ...
} else {
    const want = lerpBox(session, target, t);          // stage 空间线性
    const local = this._toContainer(container, want);  // 唯一一次「屏幕 -> 局部」
    childBox.set_origin(local.x, local.y);
    childBox.set_size(local.width, local.height);
}
```

`_frozenTargets` 在 `transitioning` 变为 true 时由
`computeWindowSlots()` 的结果填充；`_toContainer()` 用容器的实际变换求逆
（`apply_relative_transform_to_point` / `get_transformed_position` +
累计缩放），而不是 `containerWidth / workareaWidth` 这种近似。

## 4. 验收判据（建议写进 MR 描述）

**数值判据**（本仓库 `tests/nested/automation.js` 已实现）：

> 对每个单调段，把 preview 的 `x, y, width, height` 对状态值 `t` 做最小二乘
> 直线拟合，最大残差应 < 1 px；stock 当前为 13–21 px（开出）与 0.6–5 px
> （关出）。对 `t` 而非时间拟合，easing 被消掉。

**测试矩阵**：单窗口 / 多窗口（>4 个，跨行）、最大化 vs 小窗口（走
`computeWindowScale` 的 1.5 分支）、`WINDOW_PREVIEW_MAXIMUM_SCALE` 生效的情况、
双显示器与不同 aspect、非整数 scale factor（fmuellner 在 #2968 note 864538
里怀疑过这条）、手势开合 vs 快捷键、**关闭一个窗口 → 鼠标悬停在另一个窗口上 →
关闭 overview**（skeller 在 !4010 note 12 专门录过这段）、离开 overview 时切换
workspace。

## 5. 仍然无解、需要在 MR 里说明的部分

1. `ControlsManagerLayout._computeWorkspacesBoxForState(WINDOW_PICKER)` 里的
   `thumbnailsHeight * expandFraction` 由**独立**的 250 ms 时间线驱动，
   因此目标容器 box 本身不是 `progress` 的线性函数。要彻底线性，需要让这条
   子动画与状态调整共用同一条时间线（或在过渡期间冻结 `expandFraction`）。
2. `_adjustSpacingAndPadding()` 底部的标签留白在过渡中途翻转，造成一次竖直位移
   （skeller 在 !4035 note 2026-02-05 里记录）。非主显示器需要这段留白，所以
   只能冻结，不能删。
3. 非活动 workspace 的浮动几何带有滚动偏移；要么显式处理，要么像 !4035 讨论里
   建议的那样用 `this._metaWorkspace.active` 限定。
4. workspace actor 的缩放/位移与窗口插值共用同一个 `t` 是问题的根源，但
   「让父级在过渡期间保持固定尺寸」属于更大的重构（背景/圆角/裁剪都要跟着
   改），建议单独 MR。

## 6. 引用素材

- issue #2968 中的诊断：skeller note 878605 / 878622；fmuellner 的
  「floating layout 相对父级」立场 note 878613/864552。
- `7f402c1c`（2020-09-05，"workspace: Cap scaled floating size to target layout
  size"）：`Math.max()` 补丁的来源，commit message 明确写了它是为了压制动画
  中途的尺寸回弹。
- !4010 的 58 条讨论（可匿名读取：
  `/-/merge_requests/4010/discussions.json`）、!4035 的 7 条讨论。
- 本仓库的实测数据与判据：[analysis.md](analysis.md)、[../tests/README.md](../tests/README.md)。

## 端点交接与生命周期修正

端点恒等并不是正确的会话交接判据：关闭概览时，冻结槽位按容器宽度
重新缩放，再经 `Math.max()` 放大，会使 `t=0` 的原始 preview 大于实际窗口。
扩展必须保持屏幕几何修正，直到 overview 隐藏之后才恢复 actor 变换；
Shell 侧应直接保证最后可见几何与实际窗口 frame 一致。

缓存属于 layout 与窗口 id，不能让另一个工作区的 allocation 清除本工作区
的记录。关闭起点取当前绘制的 window content，包含 hover 缩放；正常 picker
缓存取未受修正的外层 slot。验收同时检查路径、真实端点和稳态恢复。
