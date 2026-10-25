// 首版占位首页：后续各块（音源、播放、海报墙、歌单架、壁纸）挂到这里。
// 只做组装，不放业务逻辑。

const FEATURES = [
    '本地音乐',
    '网易云',
    'YTM',
    '淡入淡出 · 后台保活',
    '首页海报墙',
    '3D 歌单架',
    '歌词动态壁纸 · 雨滴玻璃 · 粒子舞台 · 节奏脉动 · 氛围星空'
];

export function renderHome(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'home';

    const title = document.createElement('h1');
    title.textContent = '芷湘';
    section.appendChild(title);

    const hint = document.createElement('p');
    hint.textContent = '全新重做版，首版功能正在一块一块接上来。';
    section.appendChild(hint);

    const list = document.createElement('ul');
    list.className = 'feature-list';
    for (const name of FEATURES) {
        const item = document.createElement('li');
        item.textContent = name;
        list.appendChild(item);
    }
    section.appendChild(list);

    return section;
}
