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

    function confirmLine(code, params, fields) {
      const parts = ['/maa confirm', code]
      if (params) {
        if (Array.isArray(fields)) {
          fields.forEach(function (field) {
            if (!fieldVisible(field, params)) return
            const value = params[field.key]
            if (value === undefined || value === null) return
            parts.push(field.key + '=' + encodedPanelValue(value))
          })
        }
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
      }, [execute, line, state, onSuccess])
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
      const action = useCommandButton({ execute: props.execute, line: previewReady ? props.line : '', onSuccess: props.onSuccess })
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
        data && data.status === 'ready' ? h('div', { className: 'maa-note-preview', role: 'status' },
          h('div', { className: 'maa-note-preview-title' }, '实际生效策略预览'),
          h('div', null, '生效：' + (data.supported || []).join('、')),
          h('div', null, '记忆：复用 ' + data.memory.reused + '，本次确认后新增/更新 ' + data.memory.stored + '，拒绝 ' + data.memory.rejected),
          (data.changes || []).length ? h('ul', { className: 'maa-note-preview-list' }, data.changes.map(function (item, index) {
            return h('li', { key: String(index) }, item.target + '：' + item.detail)
          })) : null,
          (data.unsupported || []).length ? h('div', { className: 'maa-note-preview-warn' }, '无法执行：' + data.unsupported.map(function (item) { return item.request + '（' + item.reason + '）' }).join('；')) : null,
          h('div', { className: 'maa-note-preview-warn' }, '尚未操作游戏；点击确认后才会写入临时配置并调用 MAA。')) : null,
        data && data.status === 'needs_model' ? h('div', { className: 'maa-note-preview maa-note-preview-warn' },
          '本地规则未识别：' + (data.unresolved || []).join('、')) : null,
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
          const selected = Array.isArray(current) ? current : []
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
          return wrapField(item, h('label', { className: 'maa-rogue-field' },
            h('span', { className: 'maa-rogue-label' }, item.label),
            h('select', {
              className: 'maa-rogue-control', value: current === undefined ? '' : String(current), disabled: disabled,
              onChange: function (event) {
                const match = visibleOptions.find(function (entry) { return String(entry.value) === event.target.value })
                update(Object.assign({ [item.key]: match ? match.value : event.target.value }, match && match.patch ? match.patch : {}))
              },
            }, visibleOptions.map(function (entry) {
              return h('option', { key: String(entry.value), value: String(entry.value) }, entry.label)
            }))))
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
                onSuccess: function () { props.store.clear(code) },
              }))
          : props.phase === 'result' && !props.block.isError && !dismissed
            ? h('div', { className: 'maa-plan-loading' }, '正在读取当前 MAA 能力…')
            : null,
      )
    }

    function MaaConfirmDock(props) {
      const plan = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
      const collapsedPair = React.useState(false)
      const collapsed = collapsedPair[0]
      const setCollapsed = collapsedPair[1]
      const code = plan ? plan.code : null
      // A fresh plan always opens expanded; collapsing is a per-plan choice.
      React.useEffect(function () { setCollapsed(false) }, [code])
      React.useEffect(function () {
        if (!plan || plan.result || !code || typeof plan.execute !== 'function') return undefined
        let disposed = false
        const refresh = function () {
          Promise.resolve(plan.execute('/maa peek ' + code)).then(function (outcome) {
            if (disposed || !outcome || outcome.kind !== 'success') return
            let payload
            try { payload = JSON.parse(outcome.text) } catch (_) { return }
            if (!payload || payload.code !== code || !payload.panel) return
            props.store.sync({
              code: code, taskPanel: payload.panel,
              capabilitySignature: payload.capabilitySignature || '',
            })
          }, function () {})
        }
        const timer = globalThis.setInterval(refresh, 15000)
        return function () { disposed = true; globalThis.clearInterval(timer) }
      }, [code, plan && plan.execute, plan && plan.result, props.store])
      if (!plan) return null
      const effective = plan.params || (plan.taskPanel ? plan.taskPanel.values : null) || null
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
              h('div', { className: 'maa-confirm-dock-summary' }, plan.summary))),
          actions)
      }
      return h('div', { className: 'maa-confirm-dock', role: 'status' },
        h('div', { className: 'maa-confirm-dock-head' },
          h('div', { className: 'maa-confirm-dock-copy' },
            h('div', { className: 'maa-confirm-dock-title' }, 'MAA 计划等待你的确认'),
            h('div', { className: 'maa-confirm-dock-summary' }, plan.summary))),
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
            onSuccess: function (outcome) { props.store.complete(plan.code, outcome.text) },
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
      ctx.slots.inject('tool.call.toolview', function () {
        return ctx.slots.register({
          name: 'tool.call.toolview',
          key: 'maa_prepare_plan',
          inject: function (sessionId) {
            return {
              execute: commandRunner(ctx, sessionId),
              store: storeFor(sessionId),
            }
          },
        }, MaaPlanCard)
      })
      ctx.slots.inject('conversation.input.dock', function () {
        return ctx.slots.register({
          name: 'conversation.input.dock', id: 'maa-confirm', order: 5,
          inject: function (sessionId) { return { store: storeFor(sessionId) } },
        }, MaaConfirmDock)
      })
      ctx.slots.inject('conversation.input.dock', function () {
        return ctx.slots.register({
          name: 'conversation.input.dock', id: 'maa-strategy-memory', order: 6,
          inject: function (sessionId) { return { execute: commandRunner(ctx, sessionId) } },
        }, MaaStrategyMemory)
      })
    }

    return { inject, apply }
  },
})
