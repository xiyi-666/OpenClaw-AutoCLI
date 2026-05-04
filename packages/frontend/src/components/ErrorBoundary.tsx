import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-screen w-screen bg-[#0D0F0E] text-[#E8EDE9] p-8">
          <div className="max-w-lg text-center">
            <div className="text-4xl mb-4">⚠️</div>
            <h1 className="text-lg font-bold mb-2" style={{ fontFamily: "'Space Mono', monospace" }}>
              Render Error
            </h1>
            <pre className="text-sm text-left text-[#FF4545] bg-[#141716] border border-[#2A2E2B] rounded p-4 overflow-auto max-h-48 mb-4" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
              {this.state.error?.message || 'Unknown error'}
            </pre>
            <button
              onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
              className="px-4 py-2 bg-[#00FF87] text-[#0D0F0E] rounded text-sm font-bold hover:opacity-90"
              style={{ fontFamily: "'IBM Plex Mono', monospace" }}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
