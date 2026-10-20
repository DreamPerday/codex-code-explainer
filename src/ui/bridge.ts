import { App } from '@modelcontextprotocol/ext-apps';
import type { SessionSeed } from '../shared/contracts.js';
import type { ProviderState } from '../shared/web.js';

export type Seed = SessionSeed & { openedFile?: { name: string; resourceUri: string } };
export class ReaderBridge {
  readonly standalone = window.parent === window;
  provider?: ProviderState;
  private token = '';
  readonly app = new App({ name: '代码随读', version: '0.5.0' }, {}, { autoResize: true });
  private connected = false;
  async webRequest<T>(route: string, method = 'GET', body?: unknown, timeout = 120000): Promise<T> {
    try {
      const response = await fetch(route, { method, headers: { 'Content-Type': 'application/json', 'X-Reader-Token': this.token }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || '网页后台请求失败。');
      return value as T;
    } catch (error) { if (error instanceof TypeError) throw new Error('无法连接本机后台，请确认服务仍在运行后刷新页面。'); throw error; }
  }
  async connect(onSeed: (seed: Seed) => void) {
    if (this.standalone) {
      let resume = ''; try { resume = sessionStorage.getItem('code-explainer.session') ?? ''; } catch {}
      const bootstrap = await this.webRequest<{ token: string; seed: Seed; settings: ProviderState }>(`/api/bootstrap${resume ? '?session=' + encodeURIComponent(resume) : ''}`);
      this.token = bootstrap.token; this.provider = bootstrap.settings; this.connected = true;
      try { sessionStorage.setItem('code-explainer.session', bootstrap.seed.sessionId); } catch {}
      const media = matchMedia('(prefers-color-scheme: dark)'); document.documentElement.dataset.theme = media.matches ? 'dark' : 'light';
      onSeed(bootstrap.seed); return;
    }
    this.app.ontoolresult = result => {
      const seed = result.structuredContent as Seed | undefined;
      if (seed?.sessionId) onSeed(seed);
    };
    this.app.onhostcontextchanged = context => {
      if (context.theme) document.documentElement.dataset.theme = context.theme;
    };
    await this.app.connect(undefined, { timeout: 12000 });
    this.connected = true;
    const theme = this.app.getHostContext()?.theme;
    if (theme) document.documentElement.dataset.theme = theme;
    if (!this.app.getHostCapabilities()?.serverTools) throw new Error('当前客户端没有提供插件工具连接。请更新客户端，或从插件入口重新打开面板。');
  }
  async call<T>(name: string, args: Record<string, unknown>, timeout = 120000): Promise<T> {
    if (!this.connected) throw new Error('仍在连接阅读器后台，请稍候。');
    const result = this.standalone ? await this.webRequest<any>('/api/tools', 'POST', { name, arguments: args }, timeout) : await this.app.callServerTool({ name, arguments: args }, { timeout });
    if (result.isError) {
      const message = result.content.find((item: { type: string }) => item.type === 'text');
      throw new Error(message?.type === 'text' ? message.text : '阅读器请求失败，请重试。');
    }
    if (!result.structuredContent) throw new Error('后台没有返回有效数据，请重新打开阅读器。');
    return result.structuredContent as T;
  }
  async close() { if (!this.standalone) await this.app.close(); }
}
