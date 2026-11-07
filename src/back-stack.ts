// 系统返回（安卓返回键／全面屏侧滑返回）的关闭器栈。
//
// 语义：后进先出——最后打开的浮层最先被系统返回关掉。各类覆盖页
// （我的页子页、速记簿、播放页）打开时用 pushBackHandler 注册自己
// 的关闭动作，任何路径关闭（点页内返回、系统返回）都必须走同一个
// close 函数，close 里再调注销函数把自己从栈里摘掉。注销函数
// 幂等：重复调用、或已被 handleBack 弹栈后调用，都无副作用。
//
// handleBack() 由 main.ts 的 backButton 监听调用：栈非空则弹栈顶
// 执行并回 true；栈空时先给还没逐个接入的 .daily-page 浮层兜底
// （歌单详情、旋律手记页等——点它们自己的返回按钮）；再空回
// false，由调用方决定下一步（退后台而不是退出进程）。

type BackHandler = () => void;

const stack: BackHandler[] = [];

export function pushBackHandler(close: BackHandler): () => void {
    stack.push(close);
    let active = true;
    return () => {
        if (!active) {
            return;
        }
        active = false;
        const index = stack.indexOf(close);
        if (index >= 0) {
            stack.splice(index, 1);
        }
    };
}

export function handleBack(): boolean {
    const top = stack.pop();
    if (top) {
        top();
        return true;
    }
    // 兜底：仍有可见的 .daily-page 浮层开着（没逐个接入返回栈的
    // 页面），点它自己的返回按钮关掉，别让系统返回直接退出应用。
    // .daily-page 是 position:fixed，offsetParent 恒为 null，
    // 可见性用 getClientRects 判断（hidden／display:none 都为空）。
    const pages = document.querySelectorAll<HTMLElement>('.daily-page');
    for (let i = pages.length - 1; i >= 0; i--) {
        const page = pages[i];
        if (!page || page.hidden || page.getClientRects().length === 0) {
            continue;
        }
        const back = page.querySelector<HTMLElement>('.daily-page-back');
        if (back) {
            back.click();
            return true;
        }
    }
    return false;
}
