'use client';

import { useEffect, useRef, useCallback } from 'react';
import { EditorView, keymap, placeholder as cmPlaceholder, dropCursor, lineNumbers } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { sql, PostgreSQL } from '@codemirror/lang-sql';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';

const lightTheme = EditorView.theme({
  '&': {
    fontSize: '12px',
    fontFamily: 'var(--font-geist-sans), sans-serif',
    height: '100%',
    backgroundColor: 'white',
  },
  '.cm-content': {
    padding: '12px',
    caretColor: 'black',
  },
  '.cm-cursor': {
    borderLeftColor: 'black',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-gutters': {
    backgroundColor: 'white',
    color: '#d1d5db',
    border: 'none',
    paddingLeft: '4px',
  },
  '.cm-activeLine': {
    backgroundColor: '#f8f9fa',
  },
  '.cm-selectionBackground': {
    backgroundColor: '#b4d5fe !important',
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: '#b4d5fe !important',
  },
  '.cm-line': {
    lineHeight: '1.6',
  },
});

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  onRun: (currentText: string) => void;
}

export function SqlEditor({ value, onChange, onRun }: SqlEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);

  onChangeRef.current = onChange;
  onRunRef.current = onRun;

  useEffect(() => {
    if (!containerRef.current) return;

    const runKeymap = keymap.of([
      {
        key: 'Ctrl-Enter',
        run: (view) => {
          onRunRef.current(view.state.doc.toString());
          return true;
        },
      },
    ]);

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString());
      }
    });

    const state = EditorState.create({
      doc: value,
      extensions: [
        runKeymap,
        defaultKeymap.filter((b) => b.key !== 'Ctrl-Enter').length
          ? keymap.of(defaultKeymap)
          : keymap.of(defaultKeymap),
        keymap.of(historyKeymap),
        history(),
        sql({ dialect: PostgreSQL }),
        syntaxHighlighting(defaultHighlightStyle),
        lineNumbers(),
        lightTheme,
        cmPlaceholder('Enter SQL query...'),
        dropCursor(),
        updateListener,
        EditorView.lineWrapping,
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      const tableName = event.dataTransfer.getData('text/plain');
      if (!tableName) return;
      event.preventDefault();
      const view = viewRef.current;
      if (!view) return;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.doc.length;
      view.dispatch({ changes: { from: pos, insert: tableName } });
    },
    [],
  );

  return (
    <div
      ref={containerRef}
      className="min-h-0 flex-1 overflow-auto"
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
      onDrop={handleDrop}
    />
  );
}
