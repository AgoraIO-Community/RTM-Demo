/**
 * env 未配置时的引导页。
 *
 * 刻意**不是报错页** —— 未配置不是异常，是尚未配置。措辞不用报错口吻
 * （见 spec「配置注入」与票 06 的 Answer）。
 */

const LOCAL_SNIPPET = 'VITE_APP_ID=你的 App ID';

const INJECT_SNIPPET = `<script>window.__ENV__ = { appId: '你的 App ID' };</script>
<script type="module" src="/assets/index.js"></script>`;

export function EnvGuide() {
  return (
    <section className="lab-guide" data-testid="env-guide">
      <div className="lab-guide__inner">
        <div className="lab-guide__intro">
          <span className="ink-eyebrow lab-guide__eyebrow">SETUP REQUIRED</span>
          <h1 className="lab-guide__title">还没有配置 App ID</h1>
          <p className="lab-guide__lead">
            实验室需要一个声网 App ID 才能连接。按下面任一种方式配置后刷新页面即可。
          </p>
        </div>

        <section className="lab-guide__section">
          <h2 className="lab-guide__section-title">
            <span aria-hidden="true">A</span><strong>本地开发</strong><span>仓库根目录 .env</span>
          </h2>
          <pre className="lab-guide__code">{LOCAL_SNIPPET}</pre>
        </section>

        <section className="lab-guide__section">
          <h2 className="lab-guide__section-title">
            <span aria-hidden="true">B</span><strong>线上部署</strong><span>上层页面在加载 bundle 前同步注入</span>
          </h2>
          <pre className="lab-guide__code">{INJECT_SNIPPET}</pre>
        </section>
      </div>
    </section>
  );
}
