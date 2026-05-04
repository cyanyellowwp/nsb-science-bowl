// Progress Dashboard — view layer over the Progress module.
// Pure rendering: no game logic, no state mutation outside Progress.

(() => {
  'use strict';

  const Dashboard = {
    init() {
      const back = $('dash-back-btn');
      if (back) back.addEventListener('click', () => Dashboard.hide());
      const exp = $('dash-export-btn');
      if (exp) exp.addEventListener('click', () => Dashboard.exportData());
      const clr = $('dash-clear-btn');
      if (clr) clr.addEventListener('click', () => Dashboard.clearData());

      document.querySelectorAll('.mastery-tabs .tab').forEach((t) => {
        t.addEventListener('click', () => {
          document.querySelectorAll('.mastery-tabs .tab').forEach((x) => x.classList.remove('active'));
          t.classList.add('active');
          Dashboard.renderMastery(t.dataset.filter);
        });
      });
    },

    show() {
      document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
      $('dashboard').classList.add('active');
      window.scrollTo(0, 0);
      Dashboard.render();
    },

    hide() {
      document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
      $('setup').classList.add('active');
    },

    render() {
      Progress.load();
      const overall = Progress.overallStats();

      const empty = $('dash-empty');
      const content = $('dash-content');
      if (overall.totalMatches === 0) {
        empty.classList.remove('hidden');
        content.classList.add('hidden');
        return;
      }
      empty.classList.add('hidden');
      content.classList.remove('hidden');

      // Top stats
      $('stat-matches').textContent = overall.totalMatches;
      $('stat-questions').textContent = overall.totalAttempts;
      $('stat-accuracy').textContent = pct(overall.accuracy);
      $('stat-best').textContent = overall.bestScore;

      // Tossup vs bonus split
      const split = $('stat-split');
      if (split) {
        split.innerHTML = `Toss-ups <strong>${pct(overall.tossupAccuracy)}</strong> · Bonuses <strong>${pct(overall.bonusAccuracy)}</strong>`;
      }

      Dashboard.renderTrend();
      Dashboard.renderCategories();
      Dashboard.renderMastery(currentMasteryFilter() || 'all');
      Dashboard.renderRecent();
    },

    renderTrend() {
      const trend = Progress.matchTrend(10);
      const chart = $('trend-chart');
      if (!trend.length) {
        chart.innerHTML = '<div class="empty-mini">No matches yet.</div>';
        return;
      }
      const w = 600, h = 140, padX = 16, padY = 16;
      const innerW = w - 2 * padX;
      const innerH = h - 2 * padY;
      const points = trend.map((m, i) => ({
        x: padX + (trend.length === 1 ? innerW / 2 : (i / (trend.length - 1)) * innerW),
        y: padY + (1 - m.accuracy) * innerH,
        accuracy: m.accuracy,
        score: m.score,
        date: new Date(m.started_at).toLocaleDateString(),
      }));
      const linePath = points.map((p, i) => (i === 0 ? 'M' : 'L') + p.x + ',' + p.y).join(' ');
      const areaPath = linePath + ` L${points[points.length - 1].x},${padY + innerH} L${points[0].x},${padY + innerH} Z`;
      const dots = points.map((p) =>
        `<g><circle cx="${p.x}" cy="${p.y}" r="4" class="trend-dot"/>` +
        `<title>${p.date} · ${pct(p.accuracy)} · ${p.score} pts</title></g>`
      ).join('');
      // Y axis grid at 0%, 50%, 100%
      const grid = [0, 0.5, 1].map((v) => {
        const y = padY + (1 - v) * innerH;
        return `<line x1="${padX}" x2="${padX + innerW}" y1="${y}" y2="${y}" class="trend-grid"/>` +
          `<text x="${padX - 6}" y="${y + 4}" class="trend-axis-label">${Math.round(v * 100)}%</text>`;
      }).join('');
      chart.innerHTML = `
        <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
          ${grid}
          <path d="${areaPath}" class="trend-area"/>
          <path d="${linePath}" class="trend-line"/>
          ${dots}
        </svg>`;
    },

    renderCategories() {
      const cats = Progress.accuracyByCategory();
      const c = $('category-bars');
      if (!cats.length) {
        c.innerHTML = '<div class="empty-mini">No data yet.</div>';
        return;
      }
      c.innerHTML = cats.map((cat) => {
        const p = Math.round(cat.accuracy * 100);
        const cls = p >= 75 ? 'high' : p < 50 ? 'low' : 'mid';
        return `<div class="cat-bar">
          <div class="cat-bar-name">${escapeHtml(cat.category)}</div>
          <div class="cat-bar-track"><div class="cat-bar-fill ${cls}" style="width:${p}%"></div></div>
          <div class="cat-bar-pct">${cat.correct}/${cat.attempts} <span>${p}%</span></div>
        </div>`;
      }).join('');
    },

    renderMastery(filter) {
      const bank = (window.QuestionBank && window.QuestionBank.concepts) ? window.QuestionBank.concepts : [];
      let concepts = Progress.concceptsWithBank(bank);

      // Counts for tab labels
      const counts = { all: concepts.length, mastered: 0, learning: 0, needs_work: 0, struggling: 0, untouched: 0 };
      for (const c of concepts) counts[c.mastery] = (counts[c.mastery] || 0) + 1;
      document.querySelectorAll('.mastery-tabs .tab').forEach((t) => {
        const k = t.dataset.filter;
        const base = t.dataset.label || t.textContent.replace(/\s*\(\d+\)$/, '');
        t.dataset.label = base;
        t.textContent = `${base} (${counts[k] || 0})`;
      });

      if (filter && filter !== 'all') concepts = concepts.filter((c) => c.mastery === filter);
      // Sort: untouched & struggling first, then by accuracy ascending
      const masteryOrder = { struggling: 0, untouched: 1, needs_work: 2, learning: 3, mastered: 4 };
      concepts.sort((a, b) => {
        const om = (masteryOrder[a.mastery] || 0) - (masteryOrder[b.mastery] || 0);
        if (om !== 0) return om;
        return a.accuracy - b.accuracy;
      });

      const tbody = $('mastery-rows');
      if (!concepts.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-mini">No concepts in this filter.</td></tr>';
        return;
      }
      tbody.innerHTML = concepts.map((c) => {
        const p = c.attempts ? Math.round(c.accuracy * 100) + '%' : '—';
        const masteryDisplay = c.mastery.replace('_', ' ');
        return `<tr>
          <td><div class="concept-name">${escapeHtml(c.concept_id)}</div>
              ${c.subcategory ? `<div class="concept-sub">${escapeHtml(c.subcategory)}</div>` : ''}</td>
          <td>${escapeHtml(c.category || '—')}</td>
          <td>${c.attempts}</td>
          <td>${c.attempts ? `${c.correct}/${c.attempts} · ${p}` : '—'}</td>
          <td><span class="mastery-pill ${c.mastery}">${masteryDisplay}</span></td>
        </tr>`;
      }).join('');
    },

    renderRecent() {
      const recent = Progress.recentMatches(10);
      const ul = $('match-list');
      if (!recent.length) {
        ul.innerHTML = '<div class="empty-mini">No matches yet.</div>';
        return;
      }
      ul.innerHTML = recent.map((m) => {
        const date = new Date(m.started_at).toLocaleString();
        const total = m.attempts.length;
        const correct = m.attempts.filter((a) => a.correct).length;
        const p = total ? Math.round((correct / total) * 100) + '%' : '—';
        const score = m.final_score || (m.team_scores ? Math.max(...Object.values(m.team_scores)) : 0);
        const modeLabel = m.mode === 'solo' ? '🎯 Solo' : '⚔️ Two-team';
        const subtitle = m.mode === 'solo'
          ? (m.player_name || 'Player')
          : (m.team_names ? `${m.team_names[1]} vs ${m.team_names[2]}` : '');
        const incomplete = m.completed ? '' : '<span class="incomplete-tag">incomplete</span>';
        return `<div class="match-row">
          <div class="match-main">
            <div class="match-title">${modeLabel} · ${escapeHtml(subtitle)} ${incomplete}</div>
            <div class="match-meta">${date} · ${total} questions · ${p} accuracy</div>
          </div>
          <div class="match-score">${score} pts</div>
        </div>`;
      }).join('');
    },

    exportData() {
      const blob = new Blob([Progress.exportJson()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `science-bowl-progress-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },

    clearData() {
      if (!confirm('Delete ALL practice progress? This cannot be undone.')) return;
      Progress.clear();
      Dashboard.render();
    },
  };

  // Helpers
  function $(id) { return document.getElementById(id); }
  function pct(v) { return (v == null || isNaN(v)) ? '—' : Math.round(v * 100) + '%'; }
  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function currentMasteryFilter() {
    const t = document.querySelector('.mastery-tabs .tab.active');
    return t ? t.dataset.filter : null;
  }

  document.addEventListener('DOMContentLoaded', () => Dashboard.init());
  window.Dashboard = Dashboard;
})();
