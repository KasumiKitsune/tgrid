import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getPlatformBridge, isTauriRuntime } from '../bridge/PlatformBridge';
import { useEditorStore } from '../store/useEditorStore';
import { BrandLogoIcon, CloseIcon, ExternalLinkIcon, UiIcon } from './Icons';

const GITHUB_REPO_URL = 'https://github.com/KasumiKitsune/tgrid';
const GITHUB_RELEASES_URL = `${GITHUB_REPO_URL}/releases`;
const GITHUB_ISSUES_URL = `${GITHUB_REPO_URL}/issues`;
const GITHUB_LATEST_API = 'https://api.github.com/repos/KasumiKitsune/tgrid/releases/latest';

interface RecommendedTool {
  id: string;
  name: string;
  tag: string;
  description: string;
  homepageUrl: string;
  repoUrl: string;
}

const RECOMMENDED_TOOLS: RecommendedTool[] = [
  {
    id: 'phonacq',
    name: 'PhonAcq',
    tag: '语音采集',
    description: '支持多端互联的方言学、语音学录制工具，适用于田野调查与实验室批量录音采集。',
    homepageUrl: 'https://kasumikitsune.github.io/PhonAcq/',
    repoUrl: 'https://github.com/KasumiKitsune/PhonAcq'
  },
  {
    id: 'praat-zh',
    name: 'Praat 汉化版',
    tag: '中文版 Praat',
    description: 'Praat 的非官方简体中文本地化版本，提供简体中文界面与面向日常语音分析的增强功能。',
    homepageUrl: 'https://kasumikitsune.github.io/praat-simplified-chinese/',
    repoUrl: 'https://github.com/KasumiKitsune/praat-simplified-chinese'
  }
];

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
}

function normalizeVersion(raw: string): string {
  return raw.trim().replace(/^v/i, '');
}

function parseSemver(raw: string): ParsedSemver | null {
  const cleaned = normalizeVersion(raw);
  const match = cleaned.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    major: Number(match[1] || 0),
    minor: Number(match[2] || 0),
    patch: Number(match[3] || 0),
    prerelease: match[4] || ''
  };
}

function compareSemver(remoteRaw: string, currentRaw: string): number {
  const a = parseSemver(remoteRaw);
  const b = parseSemver(currentRaw);
  if (!a || !b) {
    return normalizeVersion(remoteRaw) === normalizeVersion(currentRaw) ? 0 : 1;
  }
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function formatReleaseDate(iso?: string): string {
  if (!iso) return '';
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function extractReleaseSummary(body?: string): string {
  if (!body) return '';
  const lines = body
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^#+\s*/, '')
        .replace(/^[-*•]\s*/, '')
        .replace(/[`*_~]/g, '')
        .trim()
    )
    .filter((line) => line.length > 0 && !line.startsWith('http'));
  if (lines.length === 0) return '';
  const joined = lines.slice(0, 2).join('；');
  return joined.length > 110 ? `${joined.slice(0, 108)}…` : joined;
}

type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'latest'; latestVersion: string }
  | {
      status: 'available';
      latestVersion: string;
      releaseName: string;
      releaseUrl: string;
      publishedAt: string;
      summary: string;
    }
  | { status: 'no-release' }
  | { status: 'error'; message: string };

interface GitHubLatestReleasePayload {
  tag_name?: string;
  name?: string;
  html_url?: string;
  published_at?: string;
  body?: string;
}

export const AboutModal: React.FC = () => {
  const isDesktop = isTauriRuntime();
  const aboutOpen = useEditorStore((s) => s.aboutOpen);
  const setAboutOpen = useEditorStore((s) => s.setAboutOpen);
  const showToast = useEditorStore((s) => s.showToast);

  const [appVersion, setAppVersion] = useState('0.1.0');
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' });
  const backdropPointerDownRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    void getPlatformBridge()
      .getEngineInfo()
      .then((info) => {
        if (active && info?.version) {
          setAppVersion(normalizeVersion(info.version));
        }
      })
      .catch(() => {
        // Keep fallback version
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const openExternal = useCallback(
    (url: string) => {
      void getPlatformBridge()
        .openExternalUrl(url)
        .catch(() => {
          showToast('无法打开外部浏览器，请稍后重试', true);
        });
    },
    [showToast]
  );

  const handleCheckUpdate = useCallback(async () => {
    if (!isDesktop) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const timeoutId = window.setTimeout(() => controller.abort(), 10000);

    setUpdateState({ status: 'checking' });

    try {
      const resp = await fetch(GITHUB_LATEST_API, {
        method: 'GET',
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github+json'
        },
        signal: controller.signal
      });

      window.clearTimeout(timeoutId);

      if (resp.status === 404) {
        setUpdateState({ status: 'no-release' });
        return;
      }

      if (resp.status === 403 || resp.status === 429) {
        setUpdateState({
          status: 'error',
          message: 'GitHub 查询频率暂时受限，请稍后重试或直接前往发布页查看。'
        });
        return;
      }

      if (!resp.ok) {
        setUpdateState({
          status: 'error',
          message: `检查更新失败（状态码 ${resp.status}），请稍后重试。`
        });
        return;
      }

      const data = (await resp.json()) as GitHubLatestReleasePayload;
      const rawTag = (data.tag_name || data.name || '').trim();
      if (!rawTag) {
        setUpdateState({ status: 'no-release' });
        return;
      }

      const latestVersion = normalizeVersion(rawTag);
      if (compareSemver(latestVersion, appVersion) > 0) {
        setUpdateState({
          status: 'available',
          latestVersion,
          releaseName: (data.name || `v${latestVersion}`).trim(),
          releaseUrl: data.html_url || `${GITHUB_RELEASES_URL}/latest`,
          publishedAt: formatReleaseDate(data.published_at),
          summary: extractReleaseSummary(data.body)
        });
      } else {
        setUpdateState({ status: 'latest', latestVersion });
      }
    } catch (err) {
      window.clearTimeout(timeoutId);
      if (controller.signal.aborted && abortRef.current !== controller) {
        return;
      }
      const isTimeout = err instanceof DOMException && err.name === 'AbortError';
      setUpdateState({
        status: 'error',
        message: isTimeout
          ? '连接更新服务器超时，请检查网络后重试。'
          : '无法连接更新服务器，请检查网络连接后重试。'
      });
    }
  }, [appVersion, isDesktop]);

  return (
    <div
      className={`modal-backdrop ${aboutOpen ? 'open' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-hidden={!aboutOpen}
      aria-labelledby="about-modal-title"
      onPointerDown={(e) => {
        backdropPointerDownRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (backdropPointerDownRef.current && e.target === e.currentTarget) {
          setAboutOpen(false);
        }
        backdropPointerDownRef.current = false;
      }}
    >
      <div className="modal-card about-modal-card">
        <div className="modal-head">
          <span id="about-modal-title" className="modal-title">
            <BrandLogoIcon size={15} />
            <span>关于 T·Grid</span>
          </span>
          <button
            type="button"
            className="icon-btn compact"
            title="关闭 (Esc)"
            aria-label="关闭"
            onClick={() => setAboutOpen(false)}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="modal-body about-modal-body">
          {/* Identity & Project Info */}
          <div className="about-hero">
            <div className="about-hero-logo">
              <BrandLogoIcon size={46} />
            </div>
            <div className="about-hero-info">
              <div className="about-hero-title-row">
                <strong className="about-hero-name">T·Grid</strong>
                <span className="about-hero-sub">TextGrid Editor</span>
                <span className="about-version-badge">v{appVersion}</span>
              </div>
              <p className="about-hero-desc">
                面向语言学与语音学研究的 Praat 语音标注编辑器，支持时间轴精调、语谱与音高共振峰联动分析，以及出版级矢量插图导出。
              </p>
              <div className="about-meta-links">
                <span className="about-license-tag">MIT 开源协议</span>
                <button
                  type="button"
                  className="compact about-link-btn"
                  onClick={() => openExternal(GITHUB_REPO_URL)}
                >
                  <span>GitHub 仓库</span>
                  <ExternalLinkIcon size={11} />
                </button>
                <button
                  type="button"
                  className="compact about-link-btn"
                  onClick={() => openExternal(GITHUB_ISSUES_URL)}
                >
                  <span>问题反馈</span>
                  <ExternalLinkIcon size={11} />
                </button>
              </div>
            </div>
          </div>

          {/* Desktop-Only Manual Update Check (Hidden in Web / Single-File HTML) */}
          {isDesktop && (
            <section className="modal-section" aria-label="软件更新">
              <div className="modal-section-title">软件更新</div>
              <div className="about-update-box">
                <div className="about-update-top">
                  <div className="about-update-meta">
                    <span className="about-update-cur">当前安装版本：v{appVersion}</span>
                    {updateState.status === 'idle' && (
                      <span className="about-update-msg">
                        点击右侧按钮手动查询 GitHub 最新发布版本
                      </span>
                    )}
                    {updateState.status === 'checking' && (
                      <span className="about-update-msg">正在连接 GitHub 查询最新版本…</span>
                    )}
                    {updateState.status === 'latest' && (
                      <span className="about-update-msg is-ok">
                        <UiIcon name="check" size={13} />
                        <span>当前已是最新版本（v{appVersion}）</span>
                      </span>
                    )}
                    {updateState.status === 'no-release' && (
                      <span className="about-update-msg">
                        当前尚未发布正式安装包版本，可前往发布页查看动态。
                      </span>
                    )}
                    {updateState.status === 'error' && (
                      <span className="about-update-msg is-err">{updateState.message}</span>
                    )}
                  </div>

                  <button
                    type="button"
                    className="compact about-check-btn"
                    disabled={updateState.status === 'checking'}
                    onClick={() => void handleCheckUpdate()}
                  >
                    <UiIcon name="reset" size={12} />
                    <span>{updateState.status === 'checking' ? '检查中…' : '检查更新'}</span>
                  </button>
                </div>

                {updateState.status === 'available' && (
                  <div className="about-update-release">
                    <div className="about-update-release-head">
                      <span className="about-update-new-tag">
                        发现新版本 v{updateState.latestVersion}
                      </span>
                      {updateState.publishedAt && (
                        <span className="about-update-date">发布于 {updateState.publishedAt}</span>
                      )}
                    </div>
                    {updateState.summary && (
                      <p className="about-update-notes">{updateState.summary}</p>
                    )}
                    <div className="about-update-actions">
                      <button
                        type="button"
                        className="primary compact"
                        onClick={() => openExternal(updateState.releaseUrl)}
                      >
                        <span>前往下载安装包</span>
                        <ExternalLinkIcon size={11} />
                      </button>
                    </div>
                  </div>
                )}

                {(updateState.status === 'no-release' || updateState.status === 'error') && (
                  <div className="about-update-fallback">
                    <button
                      type="button"
                      className="compact about-link-btn"
                      onClick={() => openExternal(GITHUB_RELEASES_URL)}
                    >
                      <span>打开 Releases 发布页</span>
                      <ExternalLinkIcon size={11} />
                    </button>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Recommended Phonetics Tools */}
          <section className="modal-section" aria-label="相关语音学工具推荐">
            <div className="modal-section-title">同作者语音学工具推荐</div>
            <div className="about-rec-list">
              {RECOMMENDED_TOOLS.map((tool) => (
                <div key={tool.id} className="about-rec-card">
                  <div className="about-rec-head">
                    <div className="about-rec-title-wrap">
                      <strong className="about-rec-name">{tool.name}</strong>
                      <span className="about-rec-tag">{tool.tag}</span>
                    </div>
                    <div className="about-rec-actions">
                      <button
                        type="button"
                        className="compact about-link-btn"
                        onClick={() => openExternal(tool.homepageUrl)}
                      >
                        <span>项目主页</span>
                        <ExternalLinkIcon size={11} />
                      </button>
                      <button
                        type="button"
                        className="compact about-link-btn"
                        onClick={() => openExternal(tool.repoUrl)}
                      >
                        <span>GitHub</span>
                        <ExternalLinkIcon size={11} />
                      </button>
                    </div>
                  </div>
                  <p className="about-rec-desc">{tool.description}</p>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="about-modal-foot">
          <span className="about-foot-meta">KasumiKitsune · 开源语音学研究工具</span>
          <button type="button" className="compact" onClick={() => setAboutOpen(false)}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
};
