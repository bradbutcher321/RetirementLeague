// Shared achievement definitions -- used by Franchise (the per-manager badge shelf) and
// Overview (the league-wide Achievement Leaderboard), so both read the exact same badges
// and unlock logic instead of two copies drifting apart.
const ACHIEVEMENTS_LIB = (() => {
  // A season is "in progress" until it has a final standing (franchise.json leaves it 0 for
  // the current year), so a partial season is never credited as a finished one. The game
  // count alone isn't enough: reg_record includes median games from 2025 on, so Week 5
  // already reads as 10 games.
  function seasonState(season) {
    const games = (season.reg_record || '0-0').split('-').reduce((a, b) => a + (parseInt(b, 10) || 0), 0);
    if (!season.final_standing || games < 10) return 'progress';
    if (season.champion) return 'champion';
    if (season.final_standing === 2) return 'runner-up';
    if (season.made_playoffs) return 'playoffs';
    return 'missed';
  }

  function bestChampionshipStreak(p) {
    const years = p.season_history.filter(s => s.champion).map(s => s.year).sort((a, b) => a - b);
    let best = 0, bestEnd = null, run = 0, prevYear = null;
    for (const y of years) {
      run = (prevYear !== null && y === prevYear + 1) ? run + 1 : 1;
      prevYear = y;
      if (run > best) { best = run; bestEnd = y; }
    }
    return { length: best, endYear: bestEnd };
  }

  function everHitPlayoffRate(p, minSeasons, minRate) {
    let played = 0, made = 0;
    for (const s of [...p.season_history].sort((a, b) => a.year - b.year)) {
      if (seasonState(s) === 'progress') continue;
      played++;
      if (s.made_playoffs) made++;
      if (played >= minSeasons && made / played >= minRate) return true;
    }
    return false;
  }

  const EFFICIENCY_EXPERT_PCT = 85;

  const ACHIEVEMENTS = [
    { name: 'Founding Member', icon: 'shield', desc: 'Been in the league since year one',
      test: (p, ctx) => p.founded_year === ctx.foundingYear, sub: p => `Playing since ${p.founded_year}` },
    { name: '5 Season Veteran', icon: 'shield', desc: 'Play 5 seasons',
      test: p => p.seasons >= 5, sub: p => `${p.seasons} seasons played` },
    { name: 'Decade Veteran', icon: 'shield', desc: 'Play 10 seasons',
      test: p => p.seasons >= 10, sub: p => `${p.seasons} seasons played` },
    { name: 'Champion', icon: 'trophy', desc: 'Win a championship',
      test: p => p.career.standings.championships >= 1, sub: p => `${p.career.standings.championships} title${p.career.standings.championships === 1 ? '' : 's'}` },
    { name: 'Two-Time Champion', icon: 'trophy', desc: 'Win 2 championships',
      test: p => p.career.standings.championships >= 2, sub: p => `${p.career.standings.championships} titles` },
    { name: 'Dynasty', icon: 'trophy', desc: 'Win 3 championships',
      test: p => p.career.standings.championships >= 3, sub: p => `${p.career.standings.championships} titles` },
    { name: 'Five-Time Champion', icon: 'trophy', desc: 'Win 5 championships',
      test: p => p.career.standings.championships >= 5, sub: p => `${p.career.standings.championships} titles` },
    { name: 'Two-Peat', icon: 'flame', desc: 'Win it back-to-back',
      test: p => bestChampionshipStreak(p).length >= 2,
      sub: p => { const s = bestChampionshipStreak(p); return `Back-to-back champion, ${s.endYear - 1}-${s.endYear}`; } },
    { name: 'Three-Peat', icon: 'flame', desc: 'Win it three years running',
      test: p => bestChampionshipStreak(p).length >= 3,
      sub: p => { const s = bestChampionshipStreak(p); return `Three straight titles, ${s.endYear - 2}-${s.endYear}`; } },
    { name: 'Iron Manager', icon: 'shield', desc: 'Make the playoffs in 75%+ of your seasons (min. 4)',
      test: p => everHitPlayoffRate(p, 4, 0.75),
      sub: p => {
        // Finished seasons only, like the unlock test and Career Arc: the
        // season in progress hasn't had a playoff field yet.
        const done = p.season_history.filter(s => seasonState(s) !== 'progress');
        return `Playoffs in ${done.filter(s => s.made_playoffs).length} of ${done.length} seasons`;
      } },
    { name: 'The Heater', icon: 'flame', desc: 'Win 5 games in a row',
      test: p => p.streaks.head_to_head.longest_win >= 5, sub: p => `${p.streaks.head_to_head.longest_win}-game win streak` },
    { name: 'Unstoppable', icon: 'flame', desc: 'Win 8 games in a row',
      test: p => p.streaks.head_to_head.longest_win >= 8, sub: p => `${p.streaks.head_to_head.longest_win}-game win streak` },
    { name: 'Ice Cold', icon: 'snow', bad: true, desc: 'Lose 5 games in a row',
      test: p => p.streaks.head_to_head.longest_loss >= 5, sub: p => `${p.streaks.head_to_head.longest_loss}-game losing streak` },
    { name: 'Rock Bottom', icon: 'snow', bad: true, desc: 'Lose 8 games in a row',
      test: p => p.streaks.head_to_head.longest_loss >= 8, sub: p => `${p.streaks.head_to_head.longest_loss}-game losing streak` },
    // Streaks against the weekly median: official median games only (the
    // median era), from franchise.json's streaks.median.
    { name: 'Above Average', icon: 'flame', desc: 'Beat the median 3 weeks in a row',
      test: p => p.streaks.median.longest_win >= 3, sub: p => `Beat the median ${p.streaks.median.longest_win} weeks in a row` },
    { name: 'Median Machine', icon: 'flame', desc: 'Beat the median 5 weeks in a row',
      test: p => p.streaks.median.longest_win >= 5, sub: p => `Beat the median ${p.streaks.median.longest_win} weeks in a row` },
    { name: 'Top-Half Lock', icon: 'flame', desc: 'Beat the median 8 weeks in a row',
      test: p => p.streaks.median.longest_win >= 8, sub: p => `Beat the median ${p.streaks.median.longest_win} weeks in a row` },
    { name: 'Below Average', icon: 'snow', bad: true, desc: 'Lose to the median 3 weeks in a row',
      test: p => p.streaks.median.longest_loss >= 3, sub: p => `Lost to the median ${p.streaks.median.longest_loss} weeks in a row` },
    { name: 'Bottom Feeder', icon: 'snow', bad: true, desc: 'Lose to the median 5 weeks in a row',
      test: p => p.streaks.median.longest_loss >= 5, sub: p => `Lost to the median ${p.streaks.median.longest_loss} weeks in a row` },
    { name: 'Basement Lease', icon: 'snow', bad: true, desc: 'Lose to the median 8 weeks in a row',
      test: p => p.streaks.median.longest_loss >= 8, sub: p => `Lost to the median ${p.streaks.median.longest_loss} weeks in a row` },
    { name: 'Efficiency Expert', icon: 'target', desc: `${EFFICIENCY_EXPERT_PCT}%+ lineup efficiency in a season`,
      test: p => !!(p.efficiency && p.efficiency.by_season.some(s => s.pct >= EFFICIENCY_EXPERT_PCT)),
      sub: p => { const s = p.efficiency.by_season.filter(s => s.pct >= EFFICIENCY_EXPERT_PCT).sort((a, b) => b.pct - a.pct)[0]; return `${s.pct.toFixed(1)}% efficiency in ${s.year}`; } },
    { name: '150 Club', icon: 'target', desc: 'Score 150+ in a single game',
      test: p => !!(p.extremes.highest_score >= 150), sub: p => `${p.extremes.highest_score.toFixed(2)} in a single game` },
    { name: '200 Club', icon: 'target', desc: 'Score 200+ in a single game',
      test: p => !!(p.extremes.highest_score >= 200), sub: p => `${p.extremes.highest_score.toFixed(2)} in a single game` },
    { name: 'Snake Eyes', icon: 'snow', bad: true, desc: 'Score under 50 in a single game',
      test: p => !!(p.extremes.lowest_score > 0 && p.extremes.lowest_score < 50), sub: p => `${p.extremes.lowest_score.toFixed(2)} in a single game` },
    { name: 'Heartbreaker', icon: 'snow', bad: true, desc: 'Lose 5 games decided by under 5 points',
      test: p => !!(p.extremes.close_losses >= 5), sub: p => `${p.extremes.close_losses} losses decided by under 5 points` },
    { name: 'Blowout Artist', icon: 'flame', desc: 'Win 3 games by 50+ points',
      test: p => !!(p.extremes.blowout_wins >= 3), sub: p => `${p.extremes.blowout_wins} wins by 50+ points` },
    { name: 'In the Green', icon: 'dollar', desc: 'Finish with a positive career net',
      test: p => !!(p.money && p.money.net_result > 0), sub: p => `$${p.money.net_result.toLocaleString()} net career` },
    { name: 'High Roller', icon: 'dollar', desc: '$1,000+ net career earnings',
      test: p => !!(p.money && p.money.net_result >= 1000), sub: p => `$${p.money.net_result.toLocaleString()} net career` },
    { name: 'Wooden Spoon', icon: 'snow', bad: true, desc: 'Finish dead last at least once',
      test: p => p.career.standings.sackos >= 1, sub: p => `${p.career.standings.sackos} season${p.career.standings.sackos === 1 ? '' : 's'} finished last` },
    { name: 'Frequent Flyer', icon: 'snow', bad: true, desc: '5+ weekly Sackos',
      test: p => p.weekly_sackos >= 5, sub: p => `${p.weekly_sackos} weekly Sackos` },
    { name: 'Got Next', icon: 'flame', desc: '80%+ all-time vs. your favorite opponent',
      test: p => !!(p.rivalries.favorite_opponent && p.rivalries.favorite_opponent.win_pct >= 80),
      sub: p => `${p.rivalries.favorite_opponent.win_pct.toFixed(1)}% vs. ${p.rivalries.favorite_opponent.opponent}` },
    { name: 'Whipping Boy', icon: 'snow', bad: true, desc: '25% or worse all-time vs. your nemesis',
      test: p => !!(p.rivalries.nemesis && p.rivalries.nemesis.win_pct <= 25),
      sub: p => `${p.rivalries.nemesis.win_pct.toFixed(1)}% vs. ${p.rivalries.nemesis.opponent}` },
  ];

  const foundingYear = players => Math.min(...players.map(x => x.founded_year).filter(y => y != null));
  const unlockedCount = (p, ctx) => ACHIEVEMENTS.filter(a => a.test(p, ctx)).length;
  const unlocked = (p, ctx) => ACHIEVEMENTS.filter(a => a.test(p, ctx));

  return { seasonState, bestChampionshipStreak, everHitPlayoffRate, EFFICIENCY_EXPERT_PCT, ACHIEVEMENTS, foundingYear, unlockedCount, unlocked };
})();
