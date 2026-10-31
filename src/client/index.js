window.__ModuleLoader__.load({
  id: 'dsh-maa-cli',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const CLIENT_STARTED_AT = Date.now()
    // Plans cancelled through the confirmation panel stay hidden in every
    // local view after the host has invalidated the one-shot code.
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
      '.maa-dock-body[hidden]{display:none!important}',
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

    function switchPanelVariant(panel, previous, params, drafts) {
      let nextParams = params
      let nextDrafts = drafts || {}
      if (panel && panel.type === 'Roguelike' && previous && params && previous.theme !== params.theme) {
        nextDrafts = Object.assign({}, nextDrafts, { [previous.theme]: previous })
        const restored = nextDrafts[params.theme]
          || (panel.preferenceVariants && panel.preferenceVariants[params.theme])
        if (restored) nextParams = Object.assign({}, params, restored, { theme: params.theme })
      }
      return { params: nextParams, drafts: nextDrafts }
    }

    // Unconfirmed panel edits survive a page refresh. Drafts are keyed by the
    // one-shot code (so they die with it) and dropped when the capability
    // signature changes, exactly like the in-memory variant drafts.
    const PLAN_DRAFT_PREFIX = 'dsh.maa.draft:'
    function writePlanDraft(code, draft) {
      if (!code) return
      try {
        if (draft) globalThis.localStorage.setItem(PLAN_DRAFT_PREFIX + code, JSON.stringify(draft))
        else globalThis.localStorage.removeItem(PLAN_DRAFT_PREFIX + code)
      } catch (_) {}
    }
    function withRestoredDraft(next) {
      if (!next || !next.code || next.params) return next
      try {
        const draft = JSON.parse(globalThis.localStorage.getItem(PLAN_DRAFT_PREFIX + next.code) || 'null')
        if (!draft || !draft.params || typeof draft.params !== 'object') return next
        if ((draft.signature || '') !== (next.capabilitySignature || '')) return next
        return Object.assign({}, next, { params: draft.params })
      } catch (_) { return next }
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
          value = next ? withRestoredDraft(next) : next
          publish()
        },
        sync: function (next) {
          if (!next || !next.code) return
          if (!value || value.code !== next.code) { value = withRestoredDraft(next); publish(); return }
          const changed = value.capabilitySignature && next.capabilitySignature
            && value.capabilitySignature !== next.capabilitySignature
          value = Object.assign({}, value, next, {
            params: changed ? null : value.params,
            variantDrafts: changed ? {} : value.variantDrafts,
          })
          publish()
        },
        clear: function (code) {
          if (!value || (code && value.code !== code)) return
          writePlanDraft(value.code, null)
          value = null
          publish()
        },
        setError: function (code, error) {
          if (!value || value.code !== code) return
          value = Object.assign({}, value, { error: String(error || '') })
          publish()
        },
        // Note-preview state belongs to the plan, not to a component: it must
        // survive minimizing, remounting and switching conversations.
        setPreview: function (code, preview) {
          if (!value || value.code !== code) return
          value = Object.assign({}, value, { preview: preview })
          publish()
        },
        // The roguelike panel appears both in the tool card and in the composer
        // dock; both read and write the same parameters so the two never
        // disagree about what will be executed.
        setParams: function (code, params) {
          if (!value || !code || value.code !== code) return
          const panel = value.taskPanel
          const previous = value.params || (panel ? panel.values : null)
          const switched = switchPanelVariant(panel, previous, params, value.variantDrafts)
          value = Object.assign({}, value, { params: switched.params, variantDrafts: switched.drafts })
          writePlanDraft(code, { params: switched.params, signature: value.capabilitySignature || '' })
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
    const runStores = new Map()
    function runStoreFor(sessionId) {
      const key = String(sessionId)
      let store = runStores.get(key)
      if (!store) { store = createRunStore(key); runStores.set(key, store) }
      return store
    }

    // ---------------------------------------------------------------------
    // Run binding. One store per DSH session, created at module scope so it
    // survives minimizing, slot remounts and switching conversations. It is the
    // single place the UI learns "which run belongs to this panel"; the host's
    // runs.json (read through /maa status) is the authority it reconciles with.
    //
    // phase: launching  – /maa confirm is in flight (no run id yet)
    //        running    – the host reported (or returned) a live run
    //        stopping   – a stop request is in flight or recorded on the host
    //        finished   – the bound run has ended; `record` holds the result
    //        observer   – another DSH session's run (read-only, never stopped here)
    // ---------------------------------------------------------------------
    const RUN_STORAGE_KEY = 'dsh.maa.run'
    const LIVE_PHASES = ['launching', 'running', 'stopping']

    function runStorageKey(sessionId) {
      return RUN_STORAGE_KEY + ':' + String(sessionId == null ? '' : sessionId)
    }

    function readStoredRun(sessionId) {
      try {
        const parsed = JSON.parse(globalThis.localStorage.getItem(runStorageKey(sessionId)) || 'null')
        if (!parsed || typeof parsed.startedAt !== 'number' || typeof parsed.phase !== 'string') return null
        if (Date.now() - parsed.startedAt > 7 * 60 * 60_000) return null
        // A restored binding is never "in flight": that request died with the
        // page. The first status read decides what it really is.
        return Object.assign({}, parsed, { inFlight: false, local: false })
      } catch (_) { return null }
    }

    function writeStoredRun(sessionId, run) {
      try {
        if (run && run.phase !== 'observer') globalThis.localStorage.setItem(runStorageKey(sessionId), JSON.stringify(run))
        else globalThis.localStorage.removeItem(runStorageKey(sessionId))
      } catch (_) {}
    }

    function createRunStore(sessionId) {
      let value = {
        run: readStoredRun(sessionId),
        runtime: { busy: false, message: '', input: '' },
        collapsed: {},
        loading: false,
        historyHidden: false,
      }
      const listeners = new Set()
      const commit = function (patch) {
        value = Object.assign({}, value, patch)
        if (Object.prototype.hasOwnProperty.call(patch, 'run')) writeStoredRun(sessionId, value.run)
        listeners.forEach(function (listener) { listener() })
      }
      return {
        sessionId: sessionId,
        getSnapshot: function () { return value },
        subscribe: function (listener) { listeners.add(listener); return function () { listeners.delete(listener) } },
        replaceRun: function (run) { commit({ run: run }) },
        updateRun: function (patch) { if (value.run) commit({ run: Object.assign({}, value.run, patch) }) },
        setRuntime: function (patch) { commit({ runtime: Object.assign({}, value.runtime, patch) }) },
        setLoading: function (loading) { commit({ loading: Boolean(loading) }) },
        setHistoryHidden: function (hidden) { commit({ historyHidden: Boolean(hidden) }) },
        isCollapsed: function (key) {
          if (!key) return false
          if (Object.prototype.hasOwnProperty.call(value.collapsed, key)) return value.collapsed[key]
          return readPanelCollapsed(key)
        },
        setCollapsed: function (key, collapsed) {
          if (!key) return
          writePanelCollapsed(key, collapsed)
          commit({ collapsed: Object.assign({}, value.collapsed, { [key]: Boolean(collapsed) }) })
        },
      }
    }

    function runViewKey(run) {
      if (!run) return ''
      return panelViewKey('run', run.code || run.runId)
    }

    function readRunRecord(execute) {
      if (typeof execute !== 'function') return Promise.resolve(null)
      return Promise.resolve(execute('/maa status')).then(function (outcome) {
        if (!outcome || outcome.kind !== 'success' || typeof outcome.text !== 'string') return null
        try { return JSON.parse(outcome.text) } catch (_) { return null }
      }, function () { return null })
    }

    function recordLabel(record) {
      return record ? (record.planSummary || record.purpose || '') : ''
    }

    function startedAtOf(record, fallback) {
      const parsed = record && record.startedAt ? Date.parse(record.startedAt) : NaN
      return Number.isFinite(parsed) ? parsed : (fallback || Date.now())
    }

    // Reconcile the local binding with the host snapshot. The host wins on
    // facts (is it running, did it stop); the local binding only fills the gap
    // while a request this tab issued is still in flight.
    function applyRunSnapshot(runs, snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return
      const current = runs.getSnapshot().run
      const running = snapshot.running
      if (running) {
        const owner = running.owner || 'self'
        if (owner === 'other' || owner === 'foreign') {
          if (current && LIVE_PHASES.indexOf(current.phase) >= 0 && (current.inFlight || current.local)) return
          runs.replaceRun({
            phase: 'observer', code: running.confirmationCode || '', runId: running.id, owner: owner,
            summary: recordLabel(running), startedAt: startedAtOf(running), record: running, message: '', error: '',
          })
          return
        }
        const same = current && (current.runId === running.id || (current.code && current.code === running.confirmationCode))
        const stopping = Boolean(running.stopping) || Boolean(same && current.phase === 'stopping' && current.inFlight)
        runs.replaceRun({
          phase: stopping ? 'stopping' : 'running',
          code: running.confirmationCode || (same ? current.code : ''),
          runId: running.id, owner: owner,
          summary: recordLabel(running) || (same ? current.summary : ''),
          startedAt: startedAtOf(running, same ? current.startedAt : 0),
          record: running,
          inFlight: Boolean(same && current.inFlight),
          message: same ? current.message || '' : '',
          // A failed stop is persisted on the host; show it until the next try.
          error: (same && current.error) || (running.stopError ? '上次停止失败：' + running.stopError : ''),
        })
        return
      }
      const launching = snapshot.launching
      if (launching && launching.code) {
        if (current && current.code === launching.code && LIVE_PHASES.indexOf(current.phase) >= 0) return
        runs.replaceRun({ phase: 'launching', code: launching.code, runId: launching.runId || '', summary: current && current.code === launching.code ? current.summary : '', startedAt: Date.now(), record: null, message: '', error: '' })
        return
      }
      if (!current) return
      if (current.phase === 'launching' && current.local) return
      if (current.phase === 'observer') { runs.replaceRun(null); return }
      const records = [snapshot.interrupted].concat(Array.isArray(snapshot.recent) ? snapshot.recent : []).filter(Boolean)
      const record = records.find(function (item) {
        return (current.runId && item.id === current.runId) || (current.code && item.confirmationCode === current.code)
      })
      if (current.phase === 'finished') {
        // Refresh the result shown for an already-finished binding.
        if (record) runs.updateRun({ runId: record.id, record: record })
        return
      }
      if (record) {
        runs.replaceRun(Object.assign({}, current, { phase: 'finished', runId: record.id, record: record, inFlight: false, local: false, error: '' }))
        return
      }
      // Nothing on the host: the confirmation failed before a run existed (or
      // its record aged out). Do not keep a stop button for a ghost.
      runs.replaceRun(null)
    }

    function loadRunStatus(runs, plans, execute) {
      if (typeof execute !== 'function') return Promise.resolve(null)
      runs.setLoading(true)
      return readRunRecord(execute).then(function (snapshot) {
        runs.setLoading(false)
        if (!snapshot) return null
        applyRunSnapshot(runs, snapshot)
        restorePendingPlan(plans, execute, snapshot.pending)
        return snapshot
      })
    }

    // After a page refresh the plan dock comes back from the host, not from a
    // replayed transcript card.
    function restorePendingPlan(plans, execute, pending) {
      if (!plans || !pending || !pending.code || dismissedPlans.has(pending.code)) return
      const current = plans.getSnapshot()
      if (current && current.code === pending.code) return
      Promise.resolve(execute('/maa peek ' + pending.code)).then(function (outcome) {
        if (!outcome || outcome.kind !== 'success') return
        let payload = null
        try { payload = JSON.parse(outcome.text) } catch (_) { return }
        if (!payload || payload.code !== pending.code || !payload.panel) return
        plans.sync({
          code: payload.code, summary: payload.summary || pending.summary || 'MAA 计划', execute: execute,
          theme: typeof payload.theme === 'string' ? payload.theme : '',
          taskPanel: payload.panel, capabilitySignature: payload.capabilitySignature || '', params: null,
          goal: payload.goal || null, workflow: payload.workflow || null,
        })
      }, function () {})
    }

    // One confirmation for both the transcript card and the composer dock.
    // A successful `/maa confirm` means the run has STARTED (it runs in the
    // background); it is never treated as the run being over.
    function startConfirmation(options) {
      const runs = options.runs
      const plans = options.plans
      const execute = options.execute
      const code = options.code
      const current = runs.getSnapshot().run
      if (!code || !options.line || typeof execute !== 'function') return Promise.resolve(null)
      if (current && LIVE_PHASES.indexOf(current.phase) >= 0 && current.phase !== 'observer') return Promise.resolve(null)
      plans.setError(code, '')
      runs.replaceRun({
        phase: 'launching', code: code, runId: '', summary: options.summary || '', startedAt: Date.now(),
        record: null, message: '', error: '', inFlight: false, local: true,
      })
      try { globalThis.localStorage.setItem('dsh.maa.history', '1') } catch (_) {}
      const settle = function (outcome) {
        const run = runs.getSnapshot().run
        const bound = Boolean(run && run.code === code)
        const text = outcome && typeof outcome.text === 'string' ? outcome.text : ''
        const runId = (text.match(/RUN-[A-F0-9]{8}/) || [])[0] || ''
        if (outcome && outcome.kind === 'success') {
          dismissedPlans.add(code)
          plans.clear(code)
          if (bound && run.phase !== 'finished') {
            runs.updateRun({ phase: run.phase === 'stopping' ? 'stopping' : 'running', runId: runId || run.runId, local: false, message: '' })
          }
          return outcome
        }
        if (/已在开始执行前取消|在启动阶段被停止/.test(text)) {
          dismissedPlans.add(code)
          plans.clear(code)
          if (bound) runs.updateRun({ phase: 'finished', runId: runId || run.runId, local: false, message: text })
          return outcome
        }
        if (bound && run.phase === 'launching') runs.replaceRun(null)
        if (/已永久失效/.test(text)) {
          dismissedPlans.add(code)
          plans.clear(code)
        } else {
          plans.setError(code, text || '本地命令执行失败。')
        }
        return outcome
      }
      return Promise.resolve(execute(options.line)).then(settle, function (reason) {
        // The transport failed: the host may still have started the run.
        // Ask once instead of guessing.
        const run = runs.getSnapshot().run
        if (run && run.code === code) runs.updateRun({ local: false })
        plans.setError(code, reason instanceof Error ? reason.message : String(reason))
        return loadRunStatus(runs, plans, execute)
      })
    }

    // Stop exactly the bound run (or the launching confirmation). Resolves after
    // the host confirmed the process tree exited — or keeps the controls with
    // the reason when it could not.
    function requestRunStop(runs, plans, execute, askFirst) {
      const run = runs.getSnapshot().run
      if (!run || LIVE_PHASES.indexOf(run.phase) < 0 || run.inFlight || typeof execute !== 'function') return Promise.resolve(null)
      if (askFirst && typeof globalThis.confirm === 'function'
        && !globalThis.confirm('关闭运行面板会停止当前 MAA 任务（终止进程，不能暂停后继续）。确定停止？')) return Promise.resolve(null)
      const target = run.runId || run.code || ''
      runs.updateRun({ phase: 'stopping', inFlight: true, error: '', message: '正在停止任务并等待 MAA 进程退出…' })
      const fail = function (text) {
        const latest = runs.getSnapshot().run
        if (latest && latest.inFlight) runs.updateRun({ phase: latest.runId || latest.code ? 'running' : latest.phase, inFlight: false, message: '', error: text || '停止任务失败。' })
      }
      return Promise.resolve(execute(target ? '/maa stop ' + target : '/maa stop')).then(function (outcome) {
        if (!outcome || outcome.kind !== 'success') {
          fail(outcome && outcome.text)
          return loadRunStatus(runs, plans, execute)
        }
        runs.updateRun({ phase: 'finished', inFlight: false, local: false, error: '', message: outcome.text || '任务已停止。' })
        return loadRunStatus(runs, plans, execute)
      }, function (reason) {
        fail(reason instanceof Error ? reason.message : String(reason))
      })
    }

    function sendRuntimeInstruction(runs, plans, execute, command) {
      const state = runs.getSnapshot()
      if (typeof execute !== 'function' || state.runtime.busy || !command) return
      runs.setRuntime({ busy: true, message: '', input: '' })
      Promise.resolve(execute('/maa ' + command)).then(function (outcome) {
        runs.setRuntime({ busy: false, message: outcome && outcome.text ? outcome.text : '运行时指令没有返回结果。' })
        loadRunStatus(runs, plans, execute)
      }, function (reason) {
        runs.setRuntime({ busy: false, message: reason instanceof Error ? reason.message : String(reason) })
      })
    }

    function ConfirmButton(props) {
      const plans = props.plans
      const runs = props.runs
      const plan = React.useSyncExternalStore(plans.subscribe, plans.getSnapshot, plans.getSnapshot)
      const runState = React.useSyncExternalStore(runs.subscribe, runs.getSnapshot, runs.getSnapshot)
      const run = runState.run
      const code = props.code
      const own = plan && plan.code === code ? plan : null
      const note = typeof props.note === 'string' ? props.note.trim() : ''
      const idlePreview = { state: 'idle', note: '', line: '', data: null, error: '' }
      const preview = own && own.preview ? own.preview : idlePreview
      const setPreview = function (next) { plans.setPreview(code, next) }
      const previewReady = note === '' || (preview.state === 'ready' && preview.note === note && preview.line === props.previewLine)
      const bound = Boolean(run && run.code === code && LIVE_PHASES.indexOf(run.phase) >= 0)
      const busyElsewhere = Boolean(run && LIVE_PHASES.indexOf(run.phase) >= 0 && run.code !== code)
      const runPreview = function () {
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
      }
      React.useEffect(function () {
        if (preview.note && (preview.note !== note || preview.line !== props.previewLine)) setPreview(idlePreview)
      }, [note, props.previewLine, preview.note, preview.line])
      const cancelNote = function () {
        if (props.onNoteChange) props.onNoteChange('')
        setPreview(idlePreview)
      }
      const confirm = function () {
        if (!props.line || !previewReady || bound || busyElsewhere) return
        startConfirmation({ runs: runs, plans: plans, execute: props.execute, code: code, line: props.line, summary: props.summary })
      }
      const data = preview.data
      const locked = bound || busyElsewhere
      return h(React.Fragment, null,
        h('button', {
          className: 'maa-plan-button', type: 'button', 'data-maa-action': 'confirm',
          disabled: !props.line || !previewReady || locked, onClick: confirm,
        }, bound ? (run.phase === 'stopping' ? '正在停止…' : '正在执行…') : '确认并执行 MAA'),
        bound
          ? h('button', {
              className: 'maa-stop-button', type: 'button', 'data-maa-action': 'stop',
              disabled: Boolean(run.inFlight), onClick: function () { requestRunStop(runs, plans, props.execute, false) },
            }, run.inFlight ? '正在停止…' : '停止任务')
          : null,
        h('span', { className: 'maa-plan-state' },
          busyElsewhere ? '已有任务在执行，完成或停止后才能确认'
          : note && !previewReady ? '请先预览备注策略' : '30 分钟内有效'),
        h('input', {
          className: 'maa-note-input', type: 'text', maxLength: 120,
          placeholder: '备注：如“优先招募维什戴尔，不买不灭的火炬”',
          title: '备注会先编译成 MAA 策略并显示预览；不会直接执行',
          value: typeof props.note === 'string' ? props.note : '',
          disabled: locked,
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
          className: 'maa-secondary-button', type: 'button', disabled: preview.state === 'running' || locked,
          onClick: runPreview,
        }, preview.state === 'running' ? '解析中…' : previewReady ? '重新预览' : '解析并预览备注') : null,
        note ? h('button', { className: 'maa-secondary-button', type: 'button', disabled: locked, onClick: cancelNote }, '取消备注策略') : null,
        // Only acknowledge the note here. The compiled details (supported,
        // unsupported, memory deltas) stay in the command JSON for the model and
        // the server, never in the panel: the panel is for humans, not a log.
        data && data.status === 'ready' ? h('div', { className: 'maa-note-preview', role: 'status' },
          h('div', { className: 'maa-note-preview-title' }, '已收到并解析【' + (data.note || note) + '】'),
          h('div', { className: 'maa-note-preview-warn' }, '尚未操作游戏；点击确认后才会写入临时配置并调用 MAA。')) : null,
        data && data.status === 'needs_model' ? h('div', { className: 'maa-note-preview', role: 'status' },
          h('div', { className: 'maa-note-preview-title' }, '已收到备注【' + (data.note || note) + '】，正在请模型识别')) : null,
        preview.error ? h('div', { className: 'maa-plan-error' }, preview.error) : null,
        own && own.error ? h('div', { className: 'maa-plan-error', 'data-maa-error': 'confirm' }, own.error) : null)
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
      const runState = React.useSyncExternalStore(props.runs.subscribe, props.runs.getSnapshot, props.runs.getSnapshot)
      const run = runState.run
      const current = plan && plan.code === code ? plan : null
      const effective = current ? (current.params || (current.taskPanel ? current.taskPanel.values : null)) : null
      const dismissed = Boolean(code) && dismissedPlans.has(code)
      const boundRun = run && code && run.code === code && run.phase !== 'observer' ? run : null
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
              goal: payload.goal || null, workflow: payload.workflow || null,
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
                code: code, plans: props.store, runs: props.runs, summary: summary || current.summary || '',
                execute: props.execute,
                line: confirmLine(code, effective, current && current.taskPanel ? current.taskPanel.fields : undefined),
                previewLine: notePreviewLine(code, effective, current && current.taskPanel ? current.taskPanel.fields : undefined),
                inputActions: props.inputActions,
                note: effective && typeof effective.note === 'string' ? effective.note : '',
                onNoteChange: function (next) {
                  props.store.setParams(code, Object.assign({}, effective, { note: next }))
                },
              }))
          : boundRun
            // The plan was consumed; the card keeps its own stop control for as
            // long as its run is live, in addition to the composer dock.
            ? h('div', { className: 'maa-plan-actions' },
                h('span', { className: 'maa-plan-state' }, RUN_PHASE_LABELS[boundRun.phase] || ''),
                LIVE_PHASES.indexOf(boundRun.phase) >= 0
                  ? h('button', {
                      className: 'maa-stop-button', type: 'button', 'data-maa-action': 'stop',
                      disabled: Boolean(boundRun.inFlight),
                      onClick: function () { requestRunStop(props.runs, props.store, props.execute, false) },
                    }, boundRun.inFlight ? '正在停止…' : '停止任务')
                  : null,
                boundRun.error ? h('div', { className: 'maa-plan-error' }, boundRun.error) : null)
            : props.phase === 'result' && !props.block.isError && !dismissed
              ? h('div', { className: 'maa-plan-loading' }, '正在读取当前 MAA 能力…')
              : null,
      )
    }

    const RUN_STATUS_LABELS = {
      running: '执行中', succeeded: '已完成', failed: '失败', stopped: '已停止', finished: '已结束',
    }
    const RUN_PHASE_LABELS = {
      launching: '正在启动 MAA…', running: 'MAA 任务执行中', stopping: 'MAA 任务正在停止', finished: 'MAA 任务已结束', observer: '另一个 DSH 会话的 MAA 任务执行中',
    }

    function formatRunClock(iso) {
      if (!iso) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      const pad = function (value) { return String(value).padStart(2, '0') }
      return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    }

    // Every `/maa …` line goes through the command plane and is echoed into the
    // transcript, so the dock never polls: it reads the host record once when it
    // mounts (refresh, DSH restart, conversation switch), after each action the
    // user takes, and when the user expands the panel or asks to refresh.
    const PANEL_VIEW_STORAGE_KEY = 'dsh.maa.panel-view'

    function panelViewKey(kind, id) {
      return kind && id ? String(kind) + ':' + String(id) : ''
    }

    function readPanelCollapsed(key) {
      if (!key) return false
      try {
        const value = JSON.parse(globalThis.localStorage.getItem(PANEL_VIEW_STORAGE_KEY) || '{}')
        return value && value[key] === true
      } catch (_) { return false }
    }

    function writePanelCollapsed(key, collapsed) {
      if (!key) return
      try {
        const value = JSON.parse(globalThis.localStorage.getItem(PANEL_VIEW_STORAGE_KEY) || '{}')
        const next = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
        if (collapsed) next[key] = true
        else delete next[key]
        globalThis.localStorage.setItem(PANEL_VIEW_STORAGE_KEY, JSON.stringify(next))
      } catch (_) {}
    }
    // end of panel view helpers

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
      const roguelike = !Array.isArray(run.taskTypes) || run.taskTypes.length === 0 || run.taskTypes.includes('Roguelike')
      const parts = []
      if (roguelike) {
        parts.push('本次进程已完成 ' + Number(progress.explorationsCompleted || 0) + ' 局探索')
        if (progress.floorReliable && Number.isInteger(progress.floor)) parts.push('当前第 ' + progress.floor + ' 层')
        else if (Number.isInteger(progress.lastSettlementFloor)) parts.push('上次结算于第 ' + progress.lastSettlementFloor + ' 层')
      }
      if (progress.stage) parts.push('关卡：' + progress.stage)
      if (roguelike && !progress.floorReliable) parts.push('当前楼层未知')
      const recruit = progress.recruit
      if (recruit && Array.isArray(recruit.results) && recruit.results.length) parts.push('公招已识别 ' + recruit.results.length + ' 次')
      if (recruit && Array.isArray(recruit.notices) && recruit.notices.length) parts.push('⚠ ' + recruit.notices.join('；') + '（未自动确认的高星招募需在游戏内手动处理）')
      if (parts.length === 0) parts.push('暂无可靠进度回调')
      const instruction = Array.isArray(run.instructions)
        ? run.instructions.find(function (item) { return ['received', 'applied', 'triggered'].includes(item.status) })
        : null
      if (instruction) parts.push('运行时指令[' + instruction.status + ']：' + (instruction.message || instruction.type))
      const recovery = run && run.recovery ? run.recovery : null
      if (recovery && !['idle', 'not_needed'].includes(recovery.status)) {
        parts.push('恢复状态：' + recovery.status + '（' + Number(recovery.attempt || 0) + '/' + Number(recovery.maxRetries || 0) + '）')
        if (recovery.diagnosis && recovery.diagnosis.reason) parts.push((recovery.diagnosis.confidence === 'confirmed' ? '已确认：' : '推测：') + recovery.diagnosis.reason)
        if (recovery.needsUser) parts.push('需要人工处理')
      }
      return parts.join(' · ')
    }

    // One shell for every dock state. Minimizing only hides the body (the
    // `hidden` attribute); it never unmounts it, so inputs, previews, buttons
    // and in-flight state are exactly as they were when the panel is expanded
    // again. The header — including the −/+ toggle — is always rendered.
    function DockShell(props) {
      return h('div', {
        className: 'maa-confirm-dock' + (props.className ? ' ' + props.className : ''),
        role: 'status', 'data-maa-dock': props.kind, 'data-collapsed': props.collapsed ? 'true' : 'false',
      },
      h('div', { className: 'maa-confirm-dock-head' },
        h('div', { className: 'maa-confirm-dock-copy' },
          h('div', { className: 'maa-confirm-dock-title' }, props.title),
          props.summary ? h('div', { className: 'maa-confirm-dock-summary' }, props.summary) : null,
          props.alert ? h('div', { className: 'maa-plan-error', 'data-maa-alert': 'true' }, props.alert) : null)),
      h('div', { className: 'maa-dock-actions' },
        h('button', {
          key: 'collapse', className: 'maa-dock-icon', type: 'button', 'data-maa-action': 'toggle',
          title: props.collapsed ? props.expandLabel : props.collapseLabel,
          'aria-label': props.collapsed ? props.expandLabel : props.collapseLabel,
          'aria-expanded': props.collapsed ? 'false' : 'true',
          onClick: props.onToggle,
        }, props.collapsed ? '+' : '\u2212'),
        props.onClose ? h('button', {
          key: 'close', className: 'maa-dock-icon', type: 'button', 'data-maa-action': 'close',
          title: props.closeLabel, 'aria-label': props.closeLabel, disabled: Boolean(props.closeDisabled),
          onClick: props.onClose,
        }, '\u00d7') : null),
      h('div', { className: 'maa-dock-body', hidden: Boolean(props.collapsed) }, props.children))
    }

    function MaaConfirmDock(props) {
      const plans = props.store
      const runs = props.runs
      const plan = React.useSyncExternalStore(plans.subscribe, plans.getSnapshot, plans.getSnapshot)
      const runState = React.useSyncExternalStore(runs.subscribe, runs.getSnapshot, runs.getSnapshot)
      const run = runState.run
      const execute = typeof props.execute === 'function' ? props.execute : (plan && plan.execute)
      const planActionPair = React.useState({ busy: false, error: '' })
      const planAction = planActionPair[0]
      const setPlanAction = planActionPair[1]
      const live = Boolean(run && LIVE_PHASES.indexOf(run.phase) >= 0)
      useRunClock(live)
      // One read on mount/re-entry restores the binding after a refresh, a DSH
      // restart or switching conversations. This is deliberately not polling.
      const loadRecord = function () { return loadRunStatus(runs, plans, execute) }
      React.useEffect(function () { loadRecord() }, [runs])

      const toggle = function (key) {
        return function () {
          const next = !runs.isCollapsed(key)
          runs.setCollapsed(key, next)
          // Expanding is an explicit gesture: refresh the authoritative status
          // once so a run that ended meanwhile is shown as ended.
          if (!next && key.indexOf('run:') === 0) loadRecord()
        }
      }

      if (run && run.phase !== 'finished') {
        const key = runViewKey(run)
        const collapsed = runs.isCollapsed(key)
        const record = run.record || null
        const startedAt = run.startedAt || startedAtOf(record)
        const title = RUN_PHASE_LABELS[run.phase] || 'MAA 任务'
        const summary = run.summary || recordLabel(record) || '正在执行'
        if (run.phase === 'observer') {
          return h(DockShell, {
            kind: 'observer', className: 'maa-run-dock', title: title, summary: summary, collapsed: collapsed,
            onToggle: toggle(key), collapseLabel: '最小化运行面板', expandLabel: '展开运行面板',
            onClose: function () { runs.replaceRun(null) }, closeLabel: '隐藏（不会停止其他会话的任务）',
          },
          h('div', { className: 'maa-run-meta' }, '开始于 ' + formatRunClock(record && record.startedAt) + (run.code ? ' · ' + run.code : '')),
          h('div', { className: 'maa-run-blocked' }, '这个任务由另一个 DSH 会话发起，只能在发起它的会话里停止；执行完成前不接受新的计划。'),
          h('div', { className: 'maa-plan-actions' },
            h('button', { className: 'maa-secondary-button', type: 'button', disabled: runState.loading, onClick: loadRecord }, runState.loading ? '正在读取…' : '刷新状态')))
        }
        const stopBusy = Boolean(run.inFlight)
        return h(DockShell, {
          kind: 'run', className: 'maa-run-dock', title: title, summary: summary, collapsed: collapsed,
          alert: run.error || '',
          onToggle: toggle(key), collapseLabel: '最小化运行面板', expandLabel: '展开运行面板',
          onClose: function () { requestRunStop(runs, plans, execute, true) },
          closeDisabled: stopBusy, closeLabel: '停止任务并关闭运行面板',
        },
        h('div', { className: 'maa-run-meta' },
          '已运行 ' + formatElapsed(Date.now() - startedAt) + ' · 开始于 ' + formatRunClock(new Date(startedAt).toISOString())
            + (run.code ? ' · ' + run.code : '') + (run.runId ? ' · ' + run.runId : '')),
        record && run.phase !== 'launching' ? h('div', { className: 'maa-run-result' }, formatRuntimeProgress(record)) : null,
        h('div', { className: 'maa-run-blocked' }, '执行完成前不接受新的计划或任务：这会抢占模拟器并覆盖临时资源，所以新计划会被明确拒绝。'),
        h('div', { className: 'maa-plan-actions' },
          h('button', {
            className: 'maa-stop-button', type: 'button', 'data-maa-action': 'stop', disabled: stopBusy,
            onClick: function () { requestRunStop(runs, plans, execute, false) },
          }, stopBusy ? '正在停止…' : '停止任务'),
          h('span', { className: 'maa-plan-state' }, stopBusy ? '正在等待进程退出并清理运行资源' : '停止会终止任务，不是可恢复的暂停'),
          h('button', { className: 'maa-secondary-button', type: 'button', disabled: runState.loading, onClick: loadRecord }, runState.loading ? '正在读取…' : '刷新状态')),
        run.phase === 'launching' ? null : h('form', {
          className: 'maa-plan-actions',
          onSubmit: function (event) {
            if (event && typeof event.preventDefault === 'function') event.preventDefault()
            const command = String(runState.runtime.input || '').trim()
            if (!command || runState.runtime.busy) return
            sendRuntimeInstruction(runs, plans, execute, command)
          },
        },
          h('input', {
            className: 'maa-note-input', type: 'text', maxLength: 120,
            placeholder: '输入运行时要求，如“再打两局就停”或“这次 Boss 关前停止”',
            value: runState.runtime.input, disabled: runState.runtime.busy,
            onChange: function (event) { runs.setRuntime({ input: event.target.value }) },
          }),
          h('button', {
            className: 'maa-secondary-button', type: 'submit',
            disabled: runState.runtime.busy || String(runState.runtime.input || '').trim() === '',
          }, runState.runtime.busy ? '正在分析…' : '发送')),
        run.message ? h('div', { className: 'maa-run-result' }, run.message) : null,
        runState.runtime.message ? h('div', { className: 'maa-run-result' }, runState.runtime.message) : null)
      }

      if (plan && !dismissedPlans.has(plan.code)) {
        const key = panelViewKey('plan', plan.code)
        const collapsed = runs.isCollapsed(key)
        const effective = plan.params || (plan.taskPanel ? plan.taskPanel.values : null) || null
        // The hunk shows the plan MAA will run. If the panel's theme select no
        // longer matches the plan's theme, say so instead of pretending.
        const chosenTheme = effective && typeof effective.theme === 'string' ? effective.theme : ''
        const themeNotice = plan.theme && chosenTheme && chosenTheme !== plan.theme
          ? '\n当前选择：' + chosenTheme + '（确认后按此主题执行）'
          : ''
        const dismiss = function () {
          if (planAction.busy) return
          if (typeof globalThis.confirm === 'function' && !globalThis.confirm('取消并删除这个待确认计划？确认码将立即失效。')) return
          const codeValue = plan.code
          setPlanAction({ busy: true, error: '' })
          Promise.resolve(execute('/maa cancel ' + codeValue)).then(function (outcome) {
            const text = outcome && outcome.text ? outcome.text : ''
            if (outcome && outcome.kind === 'success') {
              setPlanAction({ busy: false, error: '' })
              dismissedPlans.add(codeValue)
              writePanelCollapsed(key, false)
              plans.clear(codeValue)
              return
            }
            if (/已经确认并/.test(text)) {
              // Confirmation won the race: the code is now a run. Show the run
              // panel (with its stop control) instead of a dead plan.
              setPlanAction({ busy: false, error: '' })
              dismissedPlans.add(codeValue)
              plans.clear(codeValue)
              return loadRecord()
            }
            if (/没有待确认/.test(text)) {
              // Already gone on the host (expired, replaced, cancelled elsewhere):
              // the code is unusable either way.
              setPlanAction({ busy: false, error: '' })
              dismissedPlans.add(codeValue)
              plans.clear(codeValue)
              return loadRecord()
            }
            setPlanAction({ busy: false, error: text || '取消计划失败。' })
          }, function (reason) {
            setPlanAction({ busy: false, error: reason instanceof Error ? reason.message : String(reason) })
          })
        }
        return h(DockShell, {
          kind: 'plan', title: 'MAA 计划等待你的确认', summary: (plan.summary || '') + themeNotice, collapsed: collapsed,
          alert: planAction.error || (collapsed ? plan.error || '' : ''),
          onToggle: toggle(key), collapseLabel: '最小化计划', expandLabel: '展开计划',
          onClose: dismiss, closeDisabled: planAction.busy, closeLabel: '取消并删除当前计划',
        },
        h('div', { className: 'maa-run-meta' }, '确认码 ' + plan.code + ' · 30 分钟内有效 · 关闭（×）会删除计划并让确认码永久失效'),
        plan.goal
          ? h('div', { className: 'maa-run-result' },
              '目标：' + (plan.goal.title || plan.goal.id || '未命名')
                + ' · 状态：' + (plan.goal.status || '待确认')
                + (plan.workflow && Array.isArray(plan.workflow.steps) ? ' · ' + plan.workflow.steps.length + ' 个步骤' : '')
                + (Array.isArray(plan.goal.facts) && plan.goal.facts.length ? '\n依据：' + plan.goal.facts.join('；') : '')
                + (plan.goal.completion ? '\n完成条件：' + plan.goal.completion : ''))
          : null,
        plan.taskPanel && effective
          ? h(TaskSettingsPanel, {
              panel: plan.taskPanel,
              value: effective,
              disabled: false,
              onChange: function (next) { plans.setParams(plan.code, next) },
            })
          : null,
        h('div', { className: 'maa-plan-actions' },
          h(ConfirmButton, {
            code: plan.code, plans: plans, runs: runs, summary: plan.summary || '',
            execute: plan.execute || execute,
            line: confirmLine(plan.code, effective, plan.taskPanel ? plan.taskPanel.fields : undefined),
            previewLine: notePreviewLine(plan.code, effective, plan.taskPanel ? plan.taskPanel.fields : undefined),
            inputActions: props.inputActions,
            note: effective && typeof effective.note === 'string' ? effective.note : '',
            onNoteChange: function (next) {
              plans.setParams(plan.code, Object.assign({}, effective, { note: next }))
            },
          })))
      }

      if (run && run.phase === 'finished') {
        const key = runViewKey(run)
        const record = run.record || null
        const label = record ? (RUN_STATUS_LABELS[record.status] || record.status || '已结束') : '已结束'
        return h(DockShell, {
          kind: 'finished', title: '最近一次 MAA 执行：' + label, summary: run.summary || recordLabel(record) || '（没有任务摘要）',
          collapsed: runs.isCollapsed(key), onToggle: toggle(key), collapseLabel: '最小化执行记录', expandLabel: '展开执行记录',
          onClose: function () { runs.replaceRun(null) }, closeLabel: '关闭执行记录（任务已经结束）',
        },
        record ? h('div', { className: 'maa-run-meta' },
          (record.finishedAt ? '结束于 ' + formatRunClock(record.finishedAt) + ' · ' : '')
            + '耗时 ' + record.duration
            + (typeof record.exitCode === 'number' ? ' · exit ' + record.exitCode : '')
            + (record.status === 'stopped' ? ' · 已停止' : '')) : null,
        h('div', { className: 'maa-run-result' }, (record && record.summary) || run.message || 'MAA 没有返回可读的执行摘要，可以查看日志排查。'),
        record && record.recovery && record.recovery.diagnosis
          ? h('div', { className: 'maa-run-result' },
              (record.recovery.diagnosis.confidence === 'confirmed' ? '已确认故障：' : '推测故障：')
                + record.recovery.diagnosis.reason
                + (record.recovery.needsUser ? '（需要人工处理）' : ''))
          : null)
      }

      let hasHistory = false
      try { hasHistory = globalThis.localStorage.getItem('dsh.maa.history') === '1' } catch (_) { hasHistory = false }
      if (!hasHistory || runState.historyHidden) return null
      return h('div', { className: 'maa-confirm-dock', role: 'status', 'data-maa-dock': 'history' },
        h('div', { className: 'maa-confirm-dock-head' },
          h('div', { className: 'maa-confirm-dock-copy' },
            h('div', { className: 'maa-confirm-dock-title' }, 'MAA 执行记录'),
            h('div', { className: 'maa-confirm-dock-summary' }, '查看上一次执行的状态与结果（只读，不会调用模型）。'))),
        h('div', { className: 'maa-dock-actions' },
          h('button', {
            key: 'hide', className: 'maa-dock-icon', type: 'button',
            title: '不再显示执行记录入口', 'aria-label': '不再显示执行记录入口',
            onClick: function () {
              try { globalThis.localStorage.removeItem('dsh.maa.history') } catch (_) {}
              runs.setHistoryHidden(true)
            },
          }, '\u00d7')),
        h('div', { className: 'maa-plan-actions' },
          h('button', {
            className: 'maa-secondary-button', type: 'button', disabled: runState.loading,
            onClick: function () {
              loadRecord().then(function (snapshot) {
                const latest = snapshot && Array.isArray(snapshot.recent) ? snapshot.recent[0] : null
                if (latest && !runs.getSnapshot().run) {
                  runs.replaceRun({ phase: 'finished', code: latest.confirmationCode || '', runId: latest.id, summary: recordLabel(latest), startedAt: startedAtOf(latest), record: latest, message: '', error: '' })
                }
              })
            },
          }, runState.loading ? '正在读取…' : '查看执行记录')))
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
            goal: payload.goal || null, workflow: payload.workflow || null,
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
      ;['maa_prepare_plan', 'maa_prepare_strategy', 'maa_prepare_note', 'maa_goal_manager', 'maa_workflow_manager', 'maa_prepare_infrast', 'maa_copilot'].forEach(function (toolKey) {
        ctx.slots.inject('tool.call.toolview', function () {
          return ctx.slots.register({
            name: 'tool.call.toolview',
            key: toolKey,
            inject: function (sessionId) {
              return {
                execute: commandRunner(ctx, sessionId),
                store: storeFor(sessionId),
                runs: runStoreFor(sessionId),
              }
            },
          }, MaaPlanCard)
        })
      })
      ctx.slots.inject('conversation.input.dock', function () {
        return ctx.slots.register({
          name: 'conversation.input.dock', id: 'maa-confirm', order: 5,
          inject: function (sessionId) {
            return { store: storeFor(sessionId), runs: runStoreFor(sessionId), execute: commandRunner(ctx, sessionId) }
          },
        }, MaaConfirmDock)
      })
      // The strategy-memory manager is intentionally not mounted: the model
      // calls /maa strategies itself, and the panel must stay about one plan.
    }

    return { inject, apply }
  },
})
