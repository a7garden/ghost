import { forwardRef, useState, type ComponentPropsWithoutRef } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';

/** Keep browser anchors ordinary; Mac desktop links use the scoped native opener. */
export const ExternalAnchor = forwardRef<HTMLAnchorElement, ComponentPropsWithoutRef<'a'>>(function ExternalAnchor({ onClick, children, ...props }, ref) {
  const [error, setError] = useState('');
  return <>
    <a {...props} ref={ref} onClick={event => {
      onClick?.(event);
      if (event.defaultPrevented || event.button !== 0 || !isTauri() || !/Mac/.test(navigator.platform) || /iPhone|iPad/.test(navigator.userAgent)) return;
      const url = event.currentTarget.href;
      if (!/^https?:/i.test(url)) return;
      event.preventDefault();
      setError('');
      void invoke('open_external_url', { url }).catch(() => {
        setError('기본 브라우저에서 페이지를 열지 못했습니다. 링크를 다시 눌러 주세요.');
      });
    }}>{children}</a>
    {error && <span role="alert" className="ml-2 text-caption text-red">{error}</span>}
  </>;
});
