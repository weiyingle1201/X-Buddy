import { useEffect, useRef, useState } from 'react';

// 页内对话框：替代 window.confirm / alert / <a download>（部分托管环境会禁用这些能力）
type DialogState =
  | { kind: 'confirm'; text: string; okLabel: string; onOk: () => void }
  | { kind: 'alert'; text: string }
  | { kind: 'export'; title: string; filename: string; text: string; mime: string };

let setter: ((d: DialogState | null) => void) | null = null;

export const ui = {
  confirm(text: string, onOk: () => void, okLabel = '确认') {
    setter?.({ kind: 'confirm', text, okLabel, onOk });
  },
  alert(text: string) {
    setter?.({ kind: 'alert', text });
  },
  exportText(title: string, filename: string, text: string, mime = 'text/markdown') {
    setter?.({ kind: 'export', title, filename, text, mime });
  },
};

export function DialogHost() {
  const [d, setD] = useState<DialogState | null>(null);
  const [copied, setCopied] = useState('');
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setter = (x) => {
      setCopied('');
      setD(x);
    };
    return () => {
      setter = null;
    };
  }, []);
  if (!d) return null;
  const close = () => setD(null);
  const copy = async () => {
    if (d.kind !== 'export') return;
    try {
      await navigator.clipboard.writeText(d.text);
      setCopied('已复制到剪贴板');
    } catch {
      ta.current?.select();
      setCopied('已选中全部文本，请按 Ctrl/⌘+C 复制');
    }
  };
  const tryDownload = () => {
    if (d.kind !== 'export') return;
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([d.text], { type: `${d.mime};charset=utf-8` }));
      a.download = d.filename;
      a.click();
      setCopied('如未开始下载，说明当前环境禁止下载，请使用“复制”');
    } catch {
      setCopied('当前环境禁止下载，请使用“复制”');
    }
  };
  return (
    <div className="drawer-mask center-mask" onClick={close}>
      <div className="dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {d.kind === 'confirm' && (
          <>
            <p>{d.text}</p>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={close}>
                取消
              </button>
              <button
                className="btn primary"
                autoFocus
                onClick={() => {
                  close();
                  d.onOk();
                }}
              >
                {d.okLabel}
              </button>
            </div>
          </>
        )}
        {d.kind === 'alert' && (
          <>
            <p>{d.text}</p>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn primary" autoFocus onClick={close}>
                知道了
              </button>
            </div>
          </>
        )}
        {d.kind === 'export' && (
          <>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <b>{d.title}</b>
              <span className="muted">{d.filename}</span>
            </div>
            <textarea id="export-text" ref={ta} readOnly value={d.text} className="export-ta" />
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="muted">{copied}</span>
              <span className="row">
                <button className="btn" onClick={tryDownload}>
                  下载文件
                </button>
                <button className="btn primary" onClick={copy}>
                  复制
                </button>
                <button className="btn" onClick={close}>
                  关闭
                </button>
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
