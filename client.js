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

    const ROGUELIKE_THEMES = [
      { value: 'Phantom', label: '傀影与猩红孤钻' },
      { value: 'Mizuki', label: '水月与深蓝之树' },
      { value: 'Sami', label: '探索者的银凇止境' },
      { value: 'Sarkaz', label: '萨卡兹的无终奇语' },
      { value: 'JieGarden', label: '界园' },
    ]

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

    // Roguelike steps carry their own settings; mirror the defaults the model
    // planned so the confirmation panel starts from MAA's actual parameters
    // instead of an empty form.
    function roguelikeDefaults(block) {
      const args = planArgs(block)
      const steps = args && Array.isArray(args.steps) ? args.steps : []
      const step = steps.find(item => item && item.type === 'Roguelike')
      if (!step) return null
      return {
        theme: typeof step.theme === 'string' ? step.theme : 'Phantom',
        startsCount: Number.isInteger(step.startsCount) ? step.startsCount : 1,
        difficulty: Number.isInteger(step.difficulty) ? step.difficulty : 0,
        squad: typeof step.squad === 'string' ? step.squad : '',
        coreChar: typeof step.coreChar === 'string' ? step.coreChar : '',
        useSupport: step.useSupport === true,
        stopAtFinalBoss: step.stopAtFinalBoss === true,
      }
    }

    // Values travel as key=value tokens on the local command plane; the server
    // validates them against the pending plan before the one-shot code is used.
    function confirmLine(code, params) {
      const parts = ['/maa confirm', code]
      if (params) {
        parts.push('theme=' + params.theme)
        parts.push('startsCount=' + params.startsCount)
        parts.push('difficulty=' + params.difficulty)
        if (params.squad) parts.push('squad=' + String(params.squad).replace(/\s+/gu, ''))
        if (params.coreChar) parts.push('coreChar=' + String(params.coreChar).replace(/\s+/gu, ''))
        parts.push('useSupport=' + (params.useSupport === true))
        parts.push('stopAtFinalBoss=' + (params.stopAtFinalBoss === true))
      }
      return parts.join(' ')
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
      const action = useCommandButton({ execute: props.execute, line: props.line, onSuccess: props.onSuccess })
      return h(React.Fragment, null,
        h('button', {
          className: 'maa-plan-button', type: 'button',
          disabled: !props.line || action.state !== 'ready', onClick: action.run,
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
          : action.state === 'done' ? '本次确认没有调用模型' : '30 分钟内有效'),
        action.error ? h('div', { className: 'maa-plan-error' }, action.error) : null,
        action.result ? h('div', { className: 'maa-plan-result', role: 'status' }, action.result) : null)
    }

    // Mirrors MAA's roguelike task settings: theme, mode/difficulty, squad,
    // starting operator, support usage, and the stop-at-final-boss switch.
    function RoguelikePanel(props) {
      const value = props.value
      const disabled = props.disabled === true
      const update = function (patch) { props.onChange(Object.assign({}, value, patch)) }
      const numberField = function (label, key, min, max) {
        return h('label', { className: 'maa-rogue-field', key: key },
          h('span', { className: 'maa-rogue-label' }, label),
          h('input', {
            className: 'maa-rogue-control', type: 'number', min: min, max: max, step: 1,
            value: value[key], disabled: disabled,
            onChange: function (event) {
              const next = Number(event.target.value)
              if (Number.isFinite(next)) update({ [key]: Math.min(max, Math.max(min, Math.round(next))) })
            },
          }))
      }
      const textField = function (label, key, placeholder) {
        return h('label', { className: 'maa-rogue-field', key: key },
          h('span', { className: 'maa-rogue-label' }, label),
          h('input', {
            className: 'maa-rogue-control', type: 'text', value: value[key], placeholder: placeholder,
            maxLength: 32, disabled: disabled,
            onChange: function (event) { update({ [key]: event.target.value }) },
          }))
      }
      const toggle = function (label, key) {
        return h('label', { className: 'maa-rogue-toggle', key: key },
          h('input', {
            type: 'checkbox', checked: value[key] === true, disabled: disabled,
            onChange: function (event) { update({ [key]: event.target.checked }) },
          }),
          label)
      }
      return h('div', { className: 'maa-rogue-panel' },
        h('div', { className: 'maa-rogue-head' },
          h('span', null, '自动肉鸽参数'),
          h('span', { className: 'maa-rogue-hint' }, '在此调整后仍用同一个确认码执行')),
        h('div', { className: 'maa-rogue-grid' },
          h('label', { className: 'maa-rogue-field' },
            h('span', { className: 'maa-rogue-label' }, '主题'),
            h('select', {
              className: 'maa-rogue-control', value: value.theme, disabled: disabled,
              onChange: function (event) { update({ theme: event.target.value }) },
            }, ROGUELIKE_THEMES.map(function (item) {
              return h('option', { key: item.value, value: item.value }, item.label)
            }))),
          numberField('刷取次数', 'startsCount', 1, 20),
          numberField('难度', 'difficulty', 0, 99),
          textField('分队', 'squad', '默认分队'),
          textField('起始干员', 'coreChar', '不指定'),
          toggle('使用助战', 'useSupport'),
          toggle('打到最终 Boss 停', 'stopAtFinalBoss')))
    }

    function MaaPlanCard(props) {
      const text = props.phase === 'result' ? resultText(props.block) : ''
      const match = text.match(/MAA-[A-F0-9]{6}/i)
      const code = match ? match[0].toUpperCase() : ''
      const summary = props.phase === 'preparing' ? '正在生成安全计划…' : planSummary(props.block)
      const defaults = props.phase === 'result' ? roguelikeDefaults(props.block) : null
      const plan = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
      const shared = plan && plan.code === code ? plan.params : null
      const effective = shared || defaults
      const dismissed = Boolean(code) && dismissedPlans.has(code)
      React.useEffect(function () {
        // Historical tool cards are replayed whenever DSH starts. Only a plan
        // produced while this client instance is alive may raise the composer
        // confirmation bar; otherwise an already-consumed old code could look
        // actionable after a restart.
        if (props.phase === 'result' && !props.block.isError && code
          && typeof props.block.time === 'number' && props.block.time >= CLIENT_STARTED_AT) {
          props.store.set({ code: code, summary: summary || 'MAA 操作计划', execute: props.execute, roguelike: defaults, params: null })
        }
      }, [props.phase, props.block, code, summary, props.store, props.execute])

      return h('div', { className: 'maa-plan-card', 'data-tool': 'maa_prepare_plan' },
        h('div', { className: 'maa-plan-title' }, 'MAA 操作计划'),
        h('div', { className: 'maa-plan-summary' }, summary || text || '正在准备…'),
        props.phase === 'result' && !props.block.isError && effective && !dismissed
          ? h(RoguelikePanel, {
              value: effective,
              disabled: false,
              onChange: function (next) { props.store.setParams(code, next) },
            })
          : null,
        props.phase === 'result' && !props.block.isError && !dismissed
          ? h('div', { className: 'maa-plan-actions' },
              h(ConfirmButton, {
                execute: props.execute,
                line: confirmLine(code, effective),
                onSuccess: function () { props.store.clear(code) },
              }))
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
      if (!plan) return null
      const effective = plan.params || plan.roguelike || null
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
        plan.roguelike && effective
          ? h(RoguelikePanel, {
              value: effective,
              disabled: false,
              onChange: function (next) { props.store.setParams(plan.code, next) },
            })
          : null,
        h('div', { className: 'maa-plan-actions' },
          h(ConfirmButton, {
            code: plan.code,
            execute: plan.execute,
            line: confirmLine(plan.code, effective),
            onSuccess: function (outcome) { props.store.complete(plan.code, outcome.text) },
          })))
    }

    const inject = ['slots', 'remote', 'remote.commands']
    function apply(ctx) {
      installStyles()
      ctx.slots.inject('tool.call.toolview', function () {
        return ctx.slots.register({
          name: 'tool.call.toolview',
          key: 'maa_prepare_plan',
          inject: function (sessionId) {
            return {
              execute: async function (line) {
                const response = await ctx.remote.commands.execute(sessionId, line, [])
                if (!response || response.ok !== true) {
                  const failure = response && response.error
                  throw new Error(failure && failure.message ? failure.message : '无法连接 DSH 本地命令服务。')
                }
                if (!response.value) return { kind: 'error', text: 'DSH 未识别 /maa 命令。' }
                return response.value.result
              },
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
    }

    return { inject, apply }
  },
})
