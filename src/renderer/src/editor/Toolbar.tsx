import { useEditorState, type Editor } from '@tiptap/react'
import { COLOR_CHOICES, FONT_CHOICES } from './extensions'

/** Formatting controls above the page. */
export function Toolbar(props: { editor: Editor }) {
  const { editor } = props
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      quote: e.isActive('blockquote'),
      font: (e.getAttributes('textStyle')['fontFamily'] as string | undefined) ?? null,
      color: (e.getAttributes('textStyle')['color'] as string | undefined) ?? null,
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  })
  const chain = () => editor.chain().focus()

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <ToolButton
        label="Bold"
        shortcut="Ctrl+B"
        active={state.bold}
        onClick={() => chain().toggleBold().run()}
      >
        <b>B</b>
      </ToolButton>
      <ToolButton
        label="Italic"
        shortcut="Ctrl+I"
        active={state.italic}
        onClick={() => chain().toggleItalic().run()}
      >
        <i>I</i>
      </ToolButton>
      <ToolButton
        label="Underline"
        shortcut="Ctrl+U"
        active={state.underline}
        onClick={() => chain().toggleUnderline().run()}
      >
        <u>U</u>
      </ToolButton>
      <span className="toolbar-gap" />
      <ToolButton
        label="Heading"
        active={state.h2}
        onClick={() => chain().toggleHeading({ level: 2 }).run()}
      >
        H1
      </ToolButton>
      <ToolButton
        label="Subheading"
        active={state.h3}
        onClick={() => chain().toggleHeading({ level: 3 }).run()}
      >
        H2
      </ToolButton>
      <ToolButton
        label="Quote"
        active={state.quote}
        onClick={() => chain().toggleBlockquote().run()}
      >
        ❝
      </ToolButton>
      <ToolButton
        label="Scene break"
        shortcut="type *** on an empty line"
        onClick={() => chain().insertSceneBreak().run()}
      >
        ***
      </ToolButton>
      <span className="toolbar-gap" />
      <select
        aria-label="Font"
        title="Font"
        value={state.font ?? ''}
        onChange={(e) =>
          e.target.value
            ? chain().setFontFamily(e.target.value).run()
            : chain().unsetFontFamily().run()
        }
      >
        {FONT_CHOICES.map((f) => (
          <option key={f.label} value={f.value ?? ''}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Text colour"
        title="Text colour"
        value={state.color ?? ''}
        onChange={(e) =>
          e.target.value ? chain().setColor(e.target.value).run() : chain().unsetColor().run()
        }
      >
        {COLOR_CHOICES.map((c) => (
          <option key={c.label} value={c.value ?? ''}>
            {c.label}
          </option>
        ))}
      </select>
      <span className="toolbar-gap" />
      <ToolButton
        label="Undo"
        shortcut="Ctrl+Z"
        disabled={!state.canUndo}
        onClick={() => chain().undo().run()}
      >
        ↶
      </ToolButton>
      <ToolButton
        label="Redo"
        shortcut="Ctrl+Shift+Z"
        disabled={!state.canRedo}
        onClick={() => chain().redo().run()}
      >
        ↷
      </ToolButton>
    </div>
  )
}

function ToolButton(props: {
  label: string
  shortcut?: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      className={`tool ${props.active ? 'active' : ''}`}
      title={props.shortcut ? `${props.label} (${props.shortcut})` : props.label}
      aria-label={props.label}
      aria-pressed={props.active}
      disabled={props.disabled}
      // Keep the text selection: don't take focus from the editor.
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}
