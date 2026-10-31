window.__ModuleLoader__.load({
  id: 'dsh-maa-cli',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const CLIENT_STARTED_AT = Date.now()
    // Plans the user deleted from the confirmation panel stay hidden for the
    // rest of this client instance. The code itself still works server-side
    // until it expires (or is consumed), so the tool card drops its own
    // confirm button as well to avoid a second, competing entry point.
    const dismissedPlans = new Set()

    const CSS = [
      '.maa-plan-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px 16px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.maa-plan-title{font-weight:600;margin-bottom:6px}',
      '.maa-plan-summary{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}',
      '.maa-plan-actions{display:flex;align-items:center;gap:10px;margin-top:12px;flex-wrap:wrap}',
      '.maa-plan-button{height:34px;padding:0 14px;border:0;border-radius:8px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);font:inherit;font-size:13px;cursor:pointer}',
      '.maa-plan-button:disabled{opacity:.55;cursor:default}',
      '.maa-stop-button{height:34px;padding:0 14px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;background:transparent;color:var(--dsw-alias-state-error-primary);font:inherit;font-size:13px;cursor:pointer}',
      '.maa-stop-button:disabled{opacity:.55;cursor:default}',
      '.maa-plan-state{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.maa-note-input{flex:1 1 220px;min-width:0;height:30px;box-sizing:border-box;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}',
      '.maa-note-input:disabled{opacity:.55;cursor:default}',
      '.maa-note-preview{width:100%;margin-top:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:18px}',
      '.maa-note-preview-title{font-weight:600;margin-bottom:4px}',
      '.maa-note-preview-list{margin:4px 0 0;padding-left:18px}',
      '.maa-note-preview-warn{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}',
      '.maa-secondary-button{height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}',
      '.maa-secondary-button:disabled{opacity:.55;cursor:default}',
      '.maa-plan-error{font-size:12px;color:var(--dsw-alias-state-error-primary)}',
      '.maa-plan-result{width:100%;margin-top:10px;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}',
      '.maa-confirm-dock{position:relative;box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width,100%);margin:0 auto;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-panel,16px);padding:14px 16px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary)}',
      '.maa-confirm-dock-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-right:84px}',
      '.maa-dock-actions{position:absolute;top:8px;right:8px;display:flex;gap:2px;z-index:1}',
      '.maa-dock-icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:16px;line-height:1;cursor:pointer}',
      '.maa-dock-icon:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.maa-confirm-dock-copy{min-width:0;flex:1 1 260px}',
      '.maa-confirm-dock-title{font-size:13px;font-weight:600}',
      '.maa-confirm-dock-summary{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.maa-rogue-panel{margin-top:10px;padding-top:10px;border-top:1px dashed var(--dsw-alias-border-l2)}',
      '.maa-rogue-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px;font-size:12px;font-weight:600}',
      '.maa-rogue-hint{font-size:11px;font-weight:400;color:var(--dsw-alias-label-secondary)}',
      '.maa-rogue-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px 16px}',
      '.maa-rogue-field{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);min-width:0}',
      '.maa-rogue-label{flex:0 0 auto;min-width:64px}',
      '.maa-rogue-control{flex:1 1 auto;min-width:0;height:28px;box-sizing:border-box;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}',
      '.maa-rogue-control:disabled{opacity:.55;cursor:default}',
      '.maa-rogue-toggle{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);min-width:0}',
      '.maa-rogue-toggle input{accent-color:var(--dsw-alias-brand-primary)}',
      '.maa-task-options{display:flex;flex-wrap:wrap;gap:6px 12px;padding:4px 0}',
      '.maa-task-option{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-primary);font-size:12px;white-space:nowrap}',
      '.maa-task-option input{accent-color:var(--dsw-alias-brand-primary)}',
      '.maa-task-field-block{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.maa-task-description{padding-left:72px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}',
      '.maa-task-notes{margin-top:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.maa-task-note{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}',
      '.maa-task-note+.maa-task-note{margin-top:8px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l2)}',
      '.maa-rogue-advanced{margin-top:10px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l2)}',
      '.maa-rogue-summary{display:block;margin-bottom:8px;font-size:12px;font-weight:600;cursor:pointer;color:var(--dsw-alias-label-secondary)}',
      '.maa-rogue-summary::-webkit-details-marker{display:none}',
      '.maa-rogue-note{margin-top:6px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.maa-memory{box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width,100%);margin:6px auto 0;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px}',
      '.maa-memory>summary{padding:9px 12px;cursor:pointer;font-weight:600}',
      '.maa-memory-body{padding:0 12px 12px}',
      '.maa-memory-category{margin-top:8px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l2)}',
      '.maa-memory-category-title{font-weight:600;margin-bottom:6px}',
      '.maa-memory-row{display:grid;grid-template-columns:minmax(120px,1fr) auto;gap:8px;align-items:center;padding:5px 0}',
      '.maa-memory-meta{font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.maa-memory-actions{display:flex;gap:5px}',
      '.maa-run-dock{border-color:var(--dsw-alias-brand-primary)}',
      '.maa-run-meta{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.maa-run-warn{font-size:11px;line-height:17px;color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary));margin-top:6px}',
      '.maa-run-result{width:100%;margin-top:8px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}',
      '.maa-run-blocked{font-size:12px;line-height:18px;color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary));padding:8px 10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px}',
    ].join('')

    function installStyles() {
      if (document.getElementById('dsh-maa-cli-styles')) return
      const tag = document.createElement('style')
      tag.id = 'dsh-maa-cli-styles'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    function resultText(block) {
      if (!block || !Array.isArray(block.content)) return ''
      return block.content.filter(item => item && item.type === 'text').map(item => item.text).join('\n')
    }

    function planArgs(block) {
      if (!block || !block.call || typeof block.call.argsRaw !== 'string') return null
      try {
        return JSON.parse(block.call.argsRaw)
      } catch (_) {
        return null
      }
    }

    function planSummary(block) {
      const args = planArgs(block)
      return args && typeof args.purpose === 'string' ? args.purpose : ''
    }

    function fieldVisible(field, values) {
      const when = field && field.when
      if (!when) return true
      if (Array.isArray(when.all)) return when.all.every(function (item) { return fieldVisible({ when: item }, values) })
      if (Array.isArray(when.any)) return when.any.some(function (item) { return fieldVisible({ when: item }, values) })
      if (Object.prototype.hasOwnProperty.call(when, 'equals')) return values[when.key] === when.equals
      if (Object.prototype.hasOwnProperty.call(when, 'notEquals')) return values[when.key] !== when.notEquals
      if (Array.isArray(when.in)) return when.in.indexOf(values[when.key]) >= 0
      if (Array.isArray(when.notIn)) return when.notIn.indexOf(values[when.key]) < 0
      return true
    }

    function encodedPanelValue(value) {
      if (Array.isArray(value)) return value.map(function (item) { return encodeURIComponent(String(item)) }).join(',')
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      return encodeURIComponent(String(value))
    }

    function normalizedFieldValue(field, params) {
      const current = params[field.key]
      if (field.kind !== 'select' && field.kind !== 'multi') return current
      const visible = (field.options || []).filter(function (entry) { return fieldVisible(entry, params) })
      if (field.kind === 'multi') {
        const selected = Array.isArray(current) ? current : []
        return visible.filter(function (entry) {
          return selected.some(function (choice) { return String(choice) === String(entry.value) })
        }).map(function (entry) { return entry.value })
      }
      const match = visible.find(function (entry) { return String(entry.value) === String(current) })
      if (match) return match.value
      return field.required === true && visible[0] ? visible[0].value : ''
    }

    function confirmLine(code, params, fields) {
      const parts = ['/maa confirm', code]
      const unset = []
      if (params) {
        if (Array.isArray(fields)) {
          fields.forEach(function (field) {
            if (!fieldVisible(field, params)) return
            const value = normalizedFieldValue(field, params)
            if (value === undefined || value === null) return
            if (field.required !== true && (value === '' || (Array.isArray(value) && value.length === 0))) {
              unset.push(field.key)
              return
            }
            parts.push(field.key + '=' + encodedPanelValue(value))
          })
        }
        if (unset.length) parts.push('_unset=' + unset.map(encodeURIComponent).join(','))
        // The note is for DSH, not MaaCore: it travels URL-encoded so spaces and
        // punctuation survive the whitespace-separated key=value tokens.
        const note = typeof params.note === 'string' ? params.note.trim() : ''
        if (note) parts.push('note=' + encodeURIComponent(note))
      }
      return parts.join(' ')
    }

    function notePreviewLine(code, params, fields) {
      const line = confirmLine(code, params, fields)
      return line.indexOf(' note=') >= 0 ? line.replace('/maa confirm', '/maa note-preview') : ''
    }

    function createPlanStore() {
      let value = null
      const listeners = new Set()
      const publish = function () { listeners.forEach(function (listener) { listener() }) }
      return {
        getSnapshot: function () { return value },
        subscribe: function (listener) { listeners.add(listener); return function () { listeners.delete(listener) } },
        set: function (next) {
          if (value && next && value.code === next.code) return
          value = next
          publish()
        },
        sync: function (next) {
          if (!next || !next.code) return
          if (!value || value.code !== next.code) { value = next; publish(); return }
          const changed = value.capabilitySignature && next.capabilitySignature
            && value.capabilitySignature !== next.capabilitySignature
          value = Object.assign({}, value, next, { params: changed ? null : value.params })
          publish()
        },
        clear: function (code) {
          if (!value || (code && value.code !== code)) return
          value = null
          publish()
        },
        // The roguelike panel appears both in the tool card and in the composer
        // dock; both read and write the same parameters so the two never
        // disagree about what will be executed.
        setParams: function (code, params) {
          if (!value || !code || value.code !== code) return
          value = Object.assign({}, value, { params: params })
          publish()
        },
        complete: function (code, result) {
          if (!value || value.code !== code) return
          value = Object.assign({}, value, { result: String(result || '执行完成。') })
          publish()
        },
      }
    }

    const stores = new Map()
    function storeFor(sessionId) {
      const key = String(sessionId)
      let store = stores.get(key)
      if (!store) { store = createPlanStore(); stores.set(key, store) }
      return store
    }

    function useCommandButton(options) {
      const execute = options.execute
      const line = options.line
      const onSuccess = options.onSuccess
      const onStart = options.onStart
      const statePair = React.useState('ready')
      const state = statePair[0]
      const setState = statePair[1]
      const errorPair = React.useState('')
      const error = errorPair[0]
      const setError = errorPair[1]
      const resultPair = React.useState('')
      const result = resultPair[0]
      const setResult = resultPair[1]
      const stopRequested = React.useRef(false)
      const run = React.useCallback(function () {
        if (!line || state !== 'ready') return
        setState('running')
        setError('')
        setResult('')
        stopRequested.current = false
        if (onStart) onStart(line)
        Promise.resolve(execute(line)).then(function (outcome) {
          if (stopRequested.current) {
            setState('stopped')
            return
          }
          if (!outcome || outcome.kind !== 'success') {
            setState('ready')
            setError(outcome && outcome.text ? outcome.text : '本地命令执行失败。')
            return
          }
          setState('done')
          setResult(outcome.text || '执行完成。')
          if (onSuccess) onSuccess(outcome)
        }, function (reason) {
          if (stopRequested.current) {
            setState('stopped')
            return
          }
          setState('ready')
          setError(reason instanceof Error ? reason.message : String(reason))
        })
      }, [execute, line, state, onSuccess, onStart])
      const stop = React.useCallback(function () {
        if (state !== 'running') return
        stopRequested.current = true
        setState('stopping')
        setError('')
        Promise.resolve(execute('/maa stop')).then(function (outcome) {
          if (!outcome || outcome.kind !== 'success') {
            stopRequested.current = false
            setState('running')
            setError(outcome && outcome.text ? outcome.text : '停止任务失败。')
            return
          }
          setState('stopped')
          setResult(outcome.text || '任务已停止。')
          if (onSuccess) onSuccess(outcome)
        }, function (reason) {
          stopRequested.current = false
          setState('running')
          setError(reason instanceof Error ? reason.message : String(reason))
        })
      }, [execute, state, onSuccess])
      return { state, error, result, run, stop }
    }

    function ConfirmButton(props) {
      const note = typeof props.note === 'string' ? props.note.trim() : ''
      const previewPair = React.useState({ state: 'idle', note: '', line: '', data: null, error: '' })
      const preview = previewPair[0]
      const setPreview = previewPair[1]
      const previewReady = note === '' || (preview.state === 'ready' && preview.note === note && preview.line === props.previewLine)
      const action = useCommandButton({ execute: props.execute, line: previewReady ? props.line : '', onSuccess: props.onSuccess, onStart: props.onStart })
      const runPreview = React.useCallback(function () {
        if (!note || !props.previewLine || preview.state === 'running') return
        setPreview({ state: 'running', note: note, line: props.previewLine, data: null, error: '' })
        Promise.resolve(props.execute(props.previewLine)).then(function (outcome) {
          if (!outcome || outcome.kind !== 'success') throw new Error(outcome && outcome.text ? outcome.text : '备注策略预览失败。')
          let data
          try { data = JSON.parse(outcome.text) } catch (_) { throw new Error('备注策略预览返回了无效数据。') }
          if (data.status === 'needs_model') {
            const input = props.inputActions
            if (!input || typeof input.setDraft !== 'function' || typeof input.submit !== 'function') {
              setPreview({ state: 'needs-model', note: note, line: props.previewLine, data: data, error: '本地规则无法确定该备注，请把下方提示发送给模型。' })
              return
            }
            input.setDraft(data.modelPrompt)
            input.submit()
            setPreview({ state: 'needs-model', note: note, line: props.previewLine, data: data, error: '本地规则无法确定，已仅针对未识别部分调用模型；当前确认按钮保持锁定。' })
            return
          }
          setPreview({ state: 'ready', note: note, line: props.previewLine, data: data, error: '' })
        }).catch(function (reason) {
          setPreview({ state: 'error', note: note, line: props.previewLine, data: null, error: reason instanceof Error ? reason.message : String(reason) })
        })
      }, [note, props.previewLine, props.execute, props.inputActions, preview.state])
      React.useEffect(function () {
        if (preview.note && (preview.note !== note || preview.line !== props.previewLine)) {
          setPreview({ state: 'idle', note: '', line: '', data: null, error: '' })
        }
      }, [note, props.previewLine, preview.note, preview.line])
      const cancelNote = function () {
        if (props.onNoteChange) props.onNoteChange('')
        setPreview({ state: 'idle', note: '', line: '', data: null, error: '' })
      }
      const data = preview.data
      return h(React.Fragment, null,
        h('button', {
          className: 'maa-plan-button', type: 'button',
          disabled: !props.line || !previewReady || action.state !== 'ready', onClick: action.run,
        }, action.state === 'running' ? '正在执行…'
          : action.state === 'stopping' ? '正在停止…'
          : action.state === 'stopped' ? '任务已停止'
          : action.state === 'done' ? '执行完成' : '确认并执行 MAA'),
        action.state === 'running' || action.state === 'stopping'
          ? h('button', {
              className: 'maa-stop-button', type: 'button',
              disabled: action.state === 'stopping', onClick: action.stop,
            }, action.state === 'stopping' ? '正在停止…' : '停止任务')
          : null,
        h('span', { className: 'maa-plan-state' },
          action.state === 'stopped' ? '不会自动继续剩余任务'
          : action.state === 'done' ? '执行结果见下方' : note && !previewReady ? '请先预览备注策略' : '30 分钟内有效'),
        h('input', {
          className: 'maa-note-input', type: 'text', maxLength: 120,
          placeholder: '备注：如“优先招募维什戴尔，不买不灭的火炬”',
          title: '备注会先编译成 MAA 策略并显示预览；不会直接执行',
          value: typeof props.note === 'string' ? props.note : '',
          disabled: action.state !== 'ready',
          onChange: function (event) {
            if (props.onNoteChange) props.onNoteChange(event.target.value)
          },
          onBlur: function (event) {
            // Compile after the user leaves the field. Clicking the explicit
            // preview button lets its own handler do this once instead.
            const target = event.relatedTarget
            const previewButton = target && typeof target.getAttribute === 'function'
              && target.getAttribute('data-maa-note-preview') === 'true'
            if (note && !previewReady && preview.state !== 'running' && !previewButton) runPreview()
          },
        }),
        note ? h('button', {
          'data-maa-note-preview': 'true',
          className: 'maa-secondary-button', type: 'button', disabled: preview.state === 'running' || action.state !== 'ready',
          onClick: runPreview,
        }, preview.state === 'running' ? '解析中…' : previewReady ? '重新预览' : '解析并预览备注') : null,
        note ? h('button', { className: 'maa-secondary-button', type: 'button', disabled: action.state !== 'ready', onClick: cancelNote }, '取消备注策略') : null,
        // Only acknowledge the note here. The compiled details (supported,
        // unsupported, memory deltas) stay in the command JSON for the model and
        // the server, never in the panel: the panel is for humans, not a log.
        data && data.status === 'ready' ? h('div', { className: 'maa-note-preview', role: 'status' },
          h('div', { className: 'maa-note-preview-title' }, '已收到并解析【' + (data.note || note) + '】'),
          h('div', { className: 'maa-note-preview-warn' }, '尚未操作游戏；点击确认后才会写入临时配置并调用 MAA。')) : null,
        data && data.status === 'needs_model' ? h('div', { className: 'maa-note-preview', role: 'status' },
          h('div', { className: 'maa-note-preview-title' }, '已收到备注【' + (data.note || note) + '】，正在请模型识别')) : null,
        preview.error ? h('div', { className: 'maa-plan-error' }, preview.error) : null,
        action.error ? h('div', { className: 'maa-plan-error' }, action.error) : null,
        action.result ? h('div', { className: 'maa-plan-result', role: 'status' }, action.result) : null)
    }

    // Generic MAA task settings. The host supplies the field definitions from
    // the same whitelist that validates `/maa confirm`, so the browser does not
    // maintain a second, drifting copy of task parameters.
    function TaskSettingsPanel(props) {
      const panel = props.panel
      const value = props.value || {}
      const disabled = props.disabled === true
      const update = function (patch) { props.onChange(Object.assign({}, value, patch)) }
      const fields = Array.isArray(panel.fields) ? panel.fields : []
      const wrapField = function (item, control) {
        return h('div', { className: 'maa-task-field-block', key: item.key },
          control,
          item.description ? h('div', { className: 'maa-task-description' }, item.description) : null)
      }

      const renderField = function (item) {
        if (!fieldVisible(item, value)) return null
        const current = value[item.key]
        if (item.kind === 'boolean') {
          return wrapField(item, h('label', { className: 'maa-rogue-toggle' },
            h('input', {
              type: 'checkbox', checked: current === true, disabled: disabled,
              onChange: function (event) { update({ [item.key]: event.target.checked }) },
            }),
            h('span', null, item.label)))
        }
        if (item.kind === 'multi') {
          const selected = normalizedFieldValue(item, value)
          return wrapField(item, h('div', { className: 'maa-rogue-field', style: { alignItems: 'flex-start' } },
            h('span', { className: 'maa-rogue-label' }, item.label),
            h('div', { className: 'maa-task-options' }, (item.options || []).map(function (entry) {
              const checked = selected.some(function (choice) { return String(choice) === String(entry.value) })
              return h('label', { className: 'maa-task-option', key: String(entry.value) },
                h('input', {
                  type: 'checkbox', checked: checked, disabled: disabled,
                  onChange: function (event) {
                    const next = selected.filter(function (choice) { return String(choice) !== String(entry.value) })
                    if (event.target.checked) next.push(entry.value)
                    update({ [item.key]: next })
                  },
                }), entry.label)
            }))))
        }
        if (item.kind === 'select') {
          const visibleOptions = (item.options || []).filter(function (entry) { return fieldVisible(entry, value) })
          const selected = normalizedFieldValue(item, value)
          const renderedOptions = visibleOptions.map(function (entry) {
            return h('option', { key: String(entry.value), value: String(entry.value) }, entry.label)
          })
          if (item.required !== true) renderedOptions.unshift(h('option', { key: '__empty', value: '' }, '未选择'))
          return wrapField(item, h('label', { className: 'maa-rogue-field' },
            h('span', { className: 'maa-rogue-label' }, item.label),
            h('select', {
              className: 'maa-rogue-control', value: String(selected), disabled: disabled,
              onChange: function (event) {
                const match = visibleOptions.find(function (entry) { return String(entry.value) === event.target.value })
                update(Object.assign({ [item.key]: match ? match.value : event.target.value }, match && match.patch ? match.patch : {}))
              },
            }, renderedOptions)))
        }
        const numeric = item.kind === 'integer' || item.kind === 'number'
        return wrapField(item, h('label', { className: 'maa-rogue-field' },
          h('span', { className: 'maa-rogue-label' }, item.label),
          h('input', {
            className: 'maa-rogue-control', type: numeric ? 'number' : 'text',
            min: numeric ? item.min : undefined, max: numeric ? item.max : undefined,
            step: numeric ? (item.step || 1) : undefined, maxLength: numeric ? undefined : item.maxLength,
            value: current === undefined || current === null ? '' : String(current),
            placeholder: item.placeholder || '', disabled: disabled,
            onChange: function (event) {
              const raw = event.target.value
              update({ [item.key]: numeric && raw !== '' ? Number(raw) : raw })
            },
          })))
      }

      const basic = fields.filter(function (item) { return !item.advanced }).map(renderField).filter(Boolean)
      const advanced = fields.filter(function (item) { return item.advanced }).map(renderField).filter(Boolean)
      const notes = (Array.isArray(panel.notes) ? panel.notes : []).filter(function (item) {
        return item && typeof item.text === 'string' && fieldVisible(item, value)
      })
      return h('div', { className: 'maa-rogue-panel' },
        h('div', { className: 'maa-rogue-head' },
          h('span', null, panel.title + '参数')),
        basic.length ? h('div', { className: 'maa-rogue-grid' }, basic) : h('div', { className: 'maa-rogue-note' }, '此项目没有可调参数。'),
        notes.length ? h('div', { className: 'maa-task-notes' }, notes.map(function (item, index) {
          return h('div', { className: 'maa-task-note', key: String(index) }, item.text)
        })) : null,
        advanced.length ? h('details', { className: 'maa-rogue-advanced' },
          h('summary', { className: 'maa-rogue-summary' }, '高级设置'),
          h('div', { className: 'maa-rogue-grid' }, advanced)) : null)
    }

    function MaaPlanCard(props) {
      const text = props.phase === 'result' ? resultText(props.block) : ''
      const match = text.match(/MAA-[A-F0-9]{6}/i)
      const code = match ? match[0].toUpperCase() : ''
      const summary = props.phase === 'preparing' ? '正在生成安全计划…' : planSummary(props.block)
      const plan = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
      const current = plan && plan.code === code ? plan : null
      const effective = current ? (current.params || (current.taskPanel ? current.taskPanel.values : null)) : null
      const dismissed = Boolean(code) && dismissedPlans.has(code)
      React.useEffect(function () {
        // Historical tool cards are replayed whenever DSH starts. Only a plan
        // produced while this client instance is alive may raise the composer
        // confirmation bar; otherwise an already-consumed old code could look
        // actionable after a restart.
        if (props.phase === 'result' && !props.block.isError && code
          && typeof props.block.time === 'number' && props.block.time >= CLIENT_STARTED_AT) {
          Promise.resolve(props.execute('/maa peek ' + code)).then(function (outcome) {
            if (!outcome || outcome.kind !== 'success') return
            let payload
            try { payload = JSON.parse(outcome.text) } catch (_) { return }
            if (!payload || payload.code !== code || !payload.panel) return
            props.store.sync({
              code: code, summary: summary || payload.summary || 'MAA 操作计划', execute: props.execute,
              theme: typeof payload.theme === 'string' ? payload.theme : '',
              taskPanel: payload.panel, capabilitySignature: payload.capabilitySignature || '', params: null,
            })
          }, function () {})
        }
      }, [props.phase, props.block, code, summary, props.store, props.execute])

      return h('div', { className: 'maa-plan-card', 'data-tool': 'maa_prepare_plan' },
        h('div', { className: 'maa-plan-title' }, 'MAA 操作计划'),
        h('div', { className: 'maa-plan-summary' }, summary || text || '正在准备…'),
        props.phase === 'result' && !props.block.isError && effective && !dismissed
          ? h(TaskSettingsPanel, {
              panel: current.taskPanel,
              value: effective,
              disabled: false,
              onChange: function (next) { props.store.setParams(code, next) },
            })
          : null,
        props.phase === 'result' && !props.block.isError && !dismissed && current && current.taskPanel
          ? h('div', { className: 'maa-plan-actions' },
              h(ConfirmButton, {
                execute: props.execute,
                line: confirmLine(code, effective, current && current.taskPanel ? current.taskPanel.fields : undefined),
                previewLine: notePreviewLine(code, effective, current && current.taskPanel ? current.taskPanel.fields : undefined),
                inputActions: props.inputActions,
                note: effective && typeof effective.note === 'string' ? effective.note : '',
                onNoteChange: function (next) {
                  props.store.setParams(code, Object.assign({}, effective, { note: next }))
                },
                onStart: function () {
                  writeStoredRun({ startedAt: Date.now(), summary: summary || '', code: code })
                  try { globalThis.localStorage.setItem('dsh.maa.history', '1') } catch (_) {}
                },
                onSuccess: function () { props.store.clear(code) },
              }))
          : props.phase === 'result' && !props.block.isError && !dismissed
            ? h('div', { className: 'maa-plan-loading' }, '正在读取当前 MAA 能力…')
            : null,
      )
    }

    const RUN_STATUS_LABELS = {
      running: '执行中', succeeded: '已完成', failed: '失败', stopped: '已停止', finished: '已结束',
    }

    function formatRunClock(iso) {
      if (!iso) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      const pad = function (value) { return String(value).padStart(2, '0') }
      return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    }

    // Every `/maa …` line goes through the command plane and is echoed into the
    // transcript, so the dock never polls: it remembers the run it started, and
    // reads the host record only when the user explicitly asks (停止 / 查看记录).
    const RUN_STORAGE_KEY = 'dsh.maa.run'

    function readStoredRun() {
      try {
        const parsed = JSON.parse(globalThis.localStorage.getItem(RUN_STORAGE_KEY) || 'null')
        if (!parsed || typeof parsed.startedAt !== 'number') return null
        if (Date.now() - parsed.startedAt > 40 * 60_000) return null
        return parsed
      } catch (_) { return null }
    }

    function writeStoredRun(run) {
      try {
        if (run) globalThis.localStorage.setItem(RUN_STORAGE_KEY, JSON.stringify(run))
        else globalThis.localStorage.removeItem(RUN_STORAGE_KEY)
      } catch (_) {}
    }

    function readRunRecord(execute) {
      if (typeof execute !== 'function') return Promise.resolve(null)
      return Promise.resolve(execute('/maa status')).then(function (outcome) {
        if (!outcome || outcome.kind !== 'success' || typeof outcome.text !== 'string') return null
        try { return JSON.parse(outcome.text) } catch (_) { return null }
      }, function () { return null })
    }

    function formatElapsed(ms) {
      const total = Math.max(0, Math.round(ms / 1000))
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      return minutes > 0 ? minutes + ' 分 ' + String(seconds).padStart(2, '0') + ' 秒' : seconds + ' 秒'
    }

    // Pure client-side ticker: the elapsed time stays honest without issuing a
    // single command (which would otherwise spam the conversation).
    function useRunClock(active) {
      const pair = React.useState(0)
      const setTick = pair[1]
      React.useEffect(function () {
        if (!active) return undefined
        const timer = globalThis.setInterval(function () { setTick(value => value + 1) }, 1000)
        return function () { globalThis.clearInterval(timer) }
      }, [active])
      return pair[0]
    }

    function formatRuntimeProgress(run) {
      const progress = run && run.progress ? run.progress : null
      if (!progress) return '实时进度尚未读取。'
      const parts = ['本次进程已完成 ' + Number(progress.explorationsCompleted || 0) + ' 局探索']
      if (progress.floorReliable && Number.isInteger(progress.floor)) parts.push('当前第 ' + progress.floor + ' 层')
      else if (Number.isInteger(progress.lastSettlementFloor)) parts.push('上次结算于第 ' + progress.lastSettlementFloor + ' 层')
      if (progress.stage) parts.push('关卡：' + progress.stage)
      if (!progress.floorReliable) parts.push('当前楼层未知')
      const instruction = Array.isArray(run.instructions)
        ? run.instructions.find(function (item) { return ['received', 'applied', 'triggered'].includes(item.status) })
        : null
      if (instruction) parts.push('运行时指令[' + instruction.status + ']：' + (instruction.message || instruction.type))
      return parts.join(' · ')
    }

    function MaaConfirmDock(props) {
      const plan = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
      const collapsedPair = React.useState(false)
      const collapsed = collapsedPair[0]
      const setCollapsed = collapsedPair[1]
      const code = plan ? plan.code : null
      const execute = typeof props.execute === 'function' ? props.execute : (plan && plan.execute)
      const localRunPair = React.useState(function () { return readStoredRun() })
      const localRun = localRunPair[0]
      const setLocalRun = localRunPair[1]
      const snapshotPair = React.useState(null)
      const snapshot = snapshotPair[0]
      const setSnapshot = snapshotPair[1]
      const loadingPair = React.useState(false)
      const loadingRecord = loadingPair[0]
      const setLoadingRecord = loadingPair[1]
      const hiddenPair = React.useState(false)
      const recordHidden = hiddenPair[0]
      const setRecordHidden = hiddenPair[1]
      const stopPair = React.useState(false)
      const stopping = stopPair[0]
      const setStopping = stopPair[1]
      const stopErrorPair = React.useState('')
      const stopError = stopErrorPair[0]
      const setStopError = stopErrorPair[1]
      const runtimePair = React.useState('')
      const runtimeMessage = runtimePair[0]
      const setRuntimeMessage = runtimePair[1]
      const runtimeBusyPair = React.useState(false)
      const runtimeBusy = runtimeBusyPair[0]
      const setRuntimeBusy = runtimeBusyPair[1]

      const runningRecord = snapshot && snapshot.running ? snapshot.running : null
      const interruptedRecord = snapshot && snapshot.interrupted ? snapshot.interrupted : null
      const recentRuns = snapshot && Array.isArray(snapshot.recent) ? snapshot.recent : []
      const finishedRun = runningRecord ? null : (interruptedRecord || recentRuns[0] || null)
      // The tab that clicked confirm remembers the run locally, so the control
      // panel appears instantly — without a single `/maa status` round trip.
      const liveRun = runningRecord || (localRun && !finishedRun ? {
        id: 'local',
        startedAt: new Date(localRun.startedAt).toISOString(),
        startedAtMs: localRun.startedAt,
        planSummary: localRun.summary || '',
        purpose: '',
        confirmationCode: localRun.code || '',
        duration: '',
      } : null)
      useRunClock(Boolean(liveRun))
      const liveStartedAt = liveRun
        ? (liveRun.startedAtMs || Date.parse(liveRun.startedAt) || Date.now())
        : 0
      const liveElapsed = liveRun ? (liveRun.duration || formatElapsed(Date.now() - liveStartedAt)) : ''

      const rememberRun = function (summary, codeValue) {
        const record = { startedAt: Date.now(), summary: summary || '', code: codeValue || '' }
        writeStoredRun(record)
        setLocalRun(record)
        setSnapshot(null)
        setRecordHidden(false)
      }
      const forgetRun = function () {
        writeStoredRun(null)
        setLocalRun(null)
      }
      const loadRecord = function () {
        setLoadingRecord(true)
        return readRunRecord(execute).then(function (data) {
          setLoadingRecord(false)
          if (data) setSnapshot(data)
          return data
        })
      }
      const stopRunning = function () {
        if (typeof execute !== 'function' || stopping) return
        setStopping(true)
        setStopError('')
        Promise.resolve(execute('/maa stop')).then(function (outcome) {
          setStopping(false)
          if (!outcome || outcome.kind !== 'success') {
            setStopError(outcome && outcome.text ? outcome.text : '停止任务失败。')
            return
          }
          forgetRun()
          loadRecord()
        }, function (reason) {
          setStopping(false)
          setStopError(reason instanceof Error ? reason.message : String(reason))
        })
      }
      const runtimeCommand = function (command) {
        if (typeof execute !== 'function' || runtimeBusy) return
        setRuntimeBusy(true)
        setRuntimeMessage('')
        Promise.resolve(execute('/maa ' + command)).then(function (outcome) {
          setRuntimeBusy(false)
          setRuntimeMessage(outcome && outcome.text ? outcome.text : '运行时指令没有返回结果。')
          loadRecord()
        }, function (reason) {
          setRuntimeBusy(false)
          setRuntimeMessage(reason instanceof Error ? reason.message : String(reason))
        })
      }
      // A fresh plan always opens expanded; collapsing is a per-plan choice.
      React.useEffect(function () { setCollapsed(false) }, [code])
      const finishedView = function (record) {
        const label = RUN_STATUS_LABELS[record.status] || record.status || '已结束'
        return h('div', { className: 'maa-confirm-dock', role: 'status' },
          h('div', { className: 'maa-confirm-dock-head' },
            h('div', { className: 'maa-confirm-dock-copy' },
              h('div', { className: 'maa-confirm-dock-title' }, '最近一次 MAA 执行：' + label),
              h('div', { className: 'maa-confirm-dock-summary' }, record.planSummary || record.purpose || '（没有任务摘要）')),
            h('div', { className: 'maa-dock-actions' },
              h('button', {
                key: 'hide', className: 'maa-dock-icon', type: 'button',
                title: '隐藏最近一次执行记录', 'aria-label': '隐藏执行记录',
                onClick: function () { setRecordHidden(true) },
              }, '\u00d7'))),
          h('div', { className: 'maa-run-meta' },
            (record.finishedAt ? '结束于 ' + formatRunClock(record.finishedAt) + ' · ' : '')
              + '耗时 ' + record.duration
              + (typeof record.exitCode === 'number' ? ' · exit ' + record.exitCode : '')
              + (record.status === 'stopped' ? ' · 已停止' : '')),
          h('div', { className: 'maa-run-result' }, record.summary || 'MAA 没有返回可读的执行摘要，可以查看日志排查。'))
      }
      if (liveRun && !recordHidden) {
        return h('div', { className: 'maa-confirm-dock maa-run-dock', role: 'status' },
          h('div', { className: 'maa-confirm-dock-head' },
            h('div', { className: 'maa-confirm-dock-copy' },
              h('div', { className: 'maa-confirm-dock-title' }, 'MAA 任务执行中'),
              h('div', { className: 'maa-confirm-dock-summary' }, liveRun.planSummary || liveRun.purpose || '正在执行')),
            h('div', { className: 'maa-dock-actions' },
              h('button', {
                key: 'hide', className: 'maa-dock-icon', type: 'button',
                title: '隐藏这次执行的提示（任务继续在后台运行）', 'aria-label': '隐藏执行提示',
                onClick: function () { setRecordHidden(true) },
              }, '\u00d7'))),
          h('div', { className: 'maa-run-meta' },
            '已运行 ' + liveElapsed + ' · 开始于 ' + formatRunClock(liveRun.startedAt)
              + (liveRun.confirmationCode ? ' · ' + liveRun.confirmationCode : '')),
          runningRecord ? h('div', { className: 'maa-run-result' }, formatRuntimeProgress(runningRecord)) : null,
          h('div', { className: 'maa-run-blocked' }, '执行完成前不接受新的计划或任务：这会抢占模拟器并覆盖临时资源，所以新计划会被明确拒绝。'),
          h('div', { className: 'maa-plan-actions' },
            h('button', { className: 'maa-stop-button', type: 'button', disabled: stopping, onClick: stopRunning },
              stopping ? '正在停止…' : '停止任务'),
            h('button', { className: 'maa-secondary-button', type: 'button', disabled: runtimeBusy, onClick: function () { runtimeCommand('这把肉鸽打完就停') } }, '本局结束后停'),
            h('button', { className: 'maa-secondary-button', type: 'button', disabled: runtimeBusy, onClick: function () { runtimeCommand('取消刚才的停止要求') } }, '取消停止条件'),
            h('button', { className: 'maa-secondary-button', type: 'button', disabled: loadingRecord, onClick: loadRecord },
              loadingRecord ? '正在读取…' : '查看实时进度')),
          runtimeMessage ? h('div', { className: 'maa-run-result' }, runtimeMessage) : null,
          stopError ? h('div', { className: 'maa-plan-error' }, stopError) : null)
      }
      if ((plan === null || plan === undefined || Boolean(plan.result)) && finishedRun && !recordHidden) {
        return finishedView(finishedRun)
      }
      if (plan === null || plan === undefined) {
        let hasHistory = false
        try { hasHistory = globalThis.localStorage.getItem('dsh.maa.history') === '1' } catch (_) { hasHistory = false }
        if (!hasHistory || recordHidden) return null
        return h('div', { className: 'maa-confirm-dock', role: 'status' },
          h('div', { className: 'maa-confirm-dock-head' },
            h('div', { className: 'maa-confirm-dock-copy' },
              h('div', { className: 'maa-confirm-dock-title' }, 'MAA 执行记录'),
              h('div', { className: 'maa-confirm-dock-summary' }, '查看上一次执行的状态与结果（只读，不会调用模型）。')),
            h('div', { className: 'maa-dock-actions' },
              h('button', {
                key: 'hide', className: 'maa-dock-icon', type: 'button',
                title: '不再显示执行记录入口', 'aria-label': '不再显示执行记录入口',
                onClick: function () {
                  try { globalThis.localStorage.removeItem('dsh.maa.history') } catch (_) {}
                  setRecordHidden(true)
                },
              }, '\u00d7'))),
          h('div', { className: 'maa-plan-actions' },
            h('button', { className: 'maa-secondary-button', type: 'button', disabled: loadingRecord, onClick: loadRecord },
              loadingRecord ? '正在读取…' : '查看执行记录')))
      }
      if (!plan) return null
      const effective = plan.params || (plan.taskPanel ? plan.taskPanel.values : null) || null
      // The hunk shows the plan MAA will run. If the panel's theme select no
      // longer matches the plan's theme, say so instead of pretending.
      const chosenTheme = effective && typeof effective.theme === 'string' ? effective.theme : ''
      const themeNotice = plan.theme && chosenTheme && chosenTheme !== plan.theme
        ? '\n当前选择：' + chosenTheme + '（确认后按此主题执行）'
        : ''
      const dockSummary = (plan.summary || '') + themeNotice
      const dismiss = function () {
        dismissedPlans.add(plan.code)
        props.store.clear(plan.code)
      }
      const actions = h('div', { className: 'maa-dock-actions' },
        h('button', {
          key: 'collapse', className: 'maa-dock-icon', type: 'button',
          title: collapsed ? '展开计划' : '最小化计划',
          'aria-label': collapsed ? '展开计划' : '最小化计划',
          onClick: function () { setCollapsed(!collapsed) },
        }, collapsed ? '+' : '\u2212'),
        h('button', {
          key: 'dismiss', className: 'maa-dock-icon', type: 'button',
          title: '删除当前计划（确认码仍有效，可用 /maa confirm 手动执行）',
          'aria-label': '删除当前计划',
          onClick: dismiss,
        }, '\u00d7'))
      if (plan.result) {
        return h('div', { className: 'maa-confirm-dock', role: 'status' },
          h('div', { className: 'maa-confirm-dock-head' },
            h('div', { className: 'maa-confirm-dock-copy' },
              h('div', { className: 'maa-confirm-dock-title' }, 'MAA 执行结果'),
              h('div', { className: 'maa-confirm-dock-summary' }, plan.result))),
          actions)
      }
      if (collapsed) {
        return h('div', { className: 'maa-confirm-dock', role: 'status' },
          h('div', { className: 'maa-confirm-dock-head' },
            h('div', { className: 'maa-confirm-dock-copy' },
              h('div', { className: 'maa-confirm-dock-title' }, 'MAA 计划等待你的确认'),
              h('div', { className: 'maa-confirm-dock-summary' }, dockSummary))),
          actions)
      }
      return h('div', { className: 'maa-confirm-dock', role: 'status' },
        h('div', { className: 'maa-confirm-dock-head' },
          h('div', { className: 'maa-confirm-dock-copy' },
            h('div', { className: 'maa-confirm-dock-title' }, 'MAA 计划等待你的确认'),
            h('div', { className: 'maa-confirm-dock-summary' }, dockSummary))),
        actions,
        plan.taskPanel && effective
          ? h(TaskSettingsPanel, {
              panel: plan.taskPanel,
              value: effective,
              disabled: false,
              onChange: function (next) { props.store.setParams(plan.code, next) },
            })
          : null,
        h('div', { className: 'maa-plan-actions' },
          h(ConfirmButton, {
            code: plan.code,
            execute: plan.execute,
            line: confirmLine(plan.code, effective, plan.taskPanel ? plan.taskPanel.fields : undefined),
            previewLine: notePreviewLine(plan.code, effective, plan.taskPanel ? plan.taskPanel.fields : undefined),
            inputActions: props.inputActions,
            note: effective && typeof effective.note === 'string' ? effective.note : '',
            onNoteChange: function (next) {
              props.store.setParams(plan.code, Object.assign({}, effective, { note: next }))
            },
            // The plan is consumed on the host; the dock must keep showing the
            // run instead of disappearing. The local record is written when the
            // confirm command starts, so no polling is needed to notice it.
            onStart: function () {
              rememberRun(plan.summary, plan.code)
            },
            onSuccess: function (outcome) {
              // The run is over: drop the optimistic local record and read the
              // authoritative one exactly once, so the dock shows duration and
              // exit code without ever polling while the task was running.
              forgetRun()
              props.store.complete(plan.code, outcome.text)
              try { globalThis.localStorage.setItem('dsh.maa.history', '1') } catch (_) {}
              loadRecord()
            },
          })))
    }

    function MaaStrategyMemory(props) {
      const dataPair = React.useState(null)
      const data = dataPair[0]
      const setData = dataPair[1]
      const statePair = React.useState('idle')
      const state = statePair[0]
      const setState = statePair[1]
      const errorPair = React.useState('')
      const error = errorPair[0]
      const setError = errorPair[1]
      const load = React.useCallback(function () {
        if (state === 'loading') return
        setState('loading'); setError('')
        Promise.resolve(props.execute('/maa strategies')).then(function (outcome) {
          if (!outcome || outcome.kind !== 'success') throw new Error(outcome && outcome.text ? outcome.text : '无法读取策略记忆。')
          setData(JSON.parse(outcome.text)); setState('ready')
        }).catch(function (reason) { setState('error'); setError(reason instanceof Error ? reason.message : String(reason)) })
      }, [props.execute, state])
      const change = function (action, id) {
        setState('loading'); setError('')
        Promise.resolve(props.execute('/maa ' + action + ' ' + id)).then(function (outcome) {
          if (!outcome || outcome.kind !== 'success') throw new Error(outcome && outcome.text ? outcome.text : '策略记忆更新失败。')
          return props.execute('/maa strategies')
        }).then(function (outcome) {
          if (!outcome || outcome.kind !== 'success') throw new Error('策略已更新，但刷新列表失败。')
          setData(JSON.parse(outcome.text)); setState('ready')
        }).catch(function (reason) { setState('error'); setError(reason instanceof Error ? reason.message : String(reason)) })
      }
      const categories = data && Array.isArray(data.categories) ? data.categories : []
      return h('details', { className: 'maa-memory', onToggle: function (event) { if (event.currentTarget.open && !data) load() } },
        h('summary', null, '策略记忆管理' + (data ? '（每类最多 ' + data.limitPerCategory + ' 条）' : '')),
        h('div', { className: 'maa-memory-body' },
          h('button', { className: 'maa-secondary-button', type: 'button', disabled: state === 'loading', onClick: load }, state === 'loading' ? '读取中…' : '刷新'),
          error ? h('div', { className: 'maa-plan-error' }, error) : null,
          state === 'ready' && categories.length === 0 ? h('div', { className: 'maa-memory-meta' }, '还没有已验证策略。') : null,
          categories.map(function (category) {
            return h('div', { className: 'maa-memory-category', key: category.name },
              h('div', { className: 'maa-memory-category-title' }, category.name + '（' + category.entries.length + '）'),
              category.entries.map(function (entry) {
                return h('div', { className: 'maa-memory-row', key: entry.id },
                  h('div', null,
                    h('div', null, entry.label),
                    h('div', { className: 'maa-memory-meta' }, entry.scope + ' · 使用 ' + entry.uses + ' 次 · ' + entry.semanticKey)),
                  h('div', { className: 'maa-memory-actions' },
                    h('button', {
                      className: 'maa-secondary-button', type: 'button', disabled: state === 'loading',
                      onClick: function () { change(entry.enabled ? 'strategy-disable' : 'strategy-enable', entry.id) },
                    }, entry.enabled ? '禁用' : '启用'),
                    h('button', {
                      className: 'maa-secondary-button', type: 'button', disabled: state === 'loading',
                      onClick: function () {
                        if (typeof globalThis.confirm === 'function' && !globalThis.confirm('删除策略“' + entry.label + '”？此操作不能从面板撤销。')) return
                        change('strategy-delete', entry.id)
                      },
                    }, '删除')))
              }))
          })))
    }

    const inject = ['slots', 'remote', 'remote.commands']

    // Run one `/maa …` line on the local command plane (zero model calls) and
    // hand the settled result back to the caller.
    function commandRunner(ctx, sessionId) {
      return async function (line) {
        const response = await ctx.remote.commands.execute(sessionId, line, [])
        if (!response || response.ok !== true) {
          const failure = response && response.error
          throw new Error(failure && failure.message ? failure.message : '无法连接 DSH 本地命令服务。')
        }
        if (!response.value) return { kind: 'error', text: 'DSH 未识别 /maa 命令。' }
        return response.value.result
      }
    }

    // `/maa rouge …` only prepares a plan on the host. Its command result is a
    // plain notice, so this listener turns that notice into the composer
    // confirmation panel: it reads the pending plan back with the read-only
    // `/maa peek`, then raises the dock. Execution still needs the user's click
    // and runs through `/maa confirm`; no model turn is involved anywhere.
    function attachPlanNotices(ctx) {
      ctx.on('command/executed', function (sessionId, name, result) {
        if (name !== 'maa' || !result || result.kind === 'error' || typeof result.text !== 'string') return
        if (result.text.indexOf('MAA 计划待确认') < 0) return
        const match = result.text.match(/MAA-[A-F0-9]{6}/)
        if (!match) return
        const code = match[0].toUpperCase()
        const execute = commandRunner(ctx, sessionId)
        const store = storeFor(sessionId)
        Promise.resolve(execute('/maa peek ' + code)).then(function (peeked) {
          if (!peeked || typeof peeked.text !== 'string') return
          let payload = null
          try {
            payload = JSON.parse(peeked.text)
          } catch (error) {
            return
          }
          if (!payload || payload.code !== code) return
          const panel = payload.panel && typeof payload.panel === 'object' ? payload.panel : null
          if (!panel || typeof panel.type !== 'string' || !panel.values || typeof panel.values !== 'object') return
          const common = {
            code: code,
            theme: typeof payload.theme === 'string' ? payload.theme : '',
            summary: typeof payload.summary === 'string' && payload.summary ? payload.summary : 'MAA 计划',
            execute: execute,
            params: null,
          }
          store.set(Object.assign(common, {
            taskPanel: panel, capabilitySignature: payload.capabilitySignature || '',
          }))
        }, function () {})
      })
    }

    function apply(ctx) {
      installStyles()
      attachPlanNotices(ctx)
      // Every planning tool shares the same confirmation dock: `maa_prepare_plan`
      // builds a task-panel plan, while `maa_prepare_strategy` / `maa_prepare_note`
      // prepare plans from notes. All three end in a MAA-XXXXXX confirmation code.
      ;['maa_prepare_plan', 'maa_prepare_strategy', 'maa_prepare_note'].forEach(function (toolKey) {
        ctx.slots.inject('tool.call.toolview', function () {
          return ctx.slots.register({
            name: 'tool.call.toolview',
            key: toolKey,
            inject: function (sessionId) {
              return {
                execute: commandRunner(ctx, sessionId),
                store: storeFor(sessionId),
              }
            },
          }, MaaPlanCard)
        })
      })
      ctx.slots.inject('conversation.input.dock', function () {
        return ctx.slots.register({
          name: 'conversation.input.dock', id: 'maa-confirm', order: 5,
          inject: function (sessionId) {
            return { store: storeFor(sessionId), execute: commandRunner(ctx, sessionId) }
          },
        }, MaaConfirmDock)
      })
      // The strategy-memory manager is intentionally not mounted: the model
      // calls /maa strategies itself, and the panel must stay about one plan.
    }

    return { inject, apply }
  },
})
