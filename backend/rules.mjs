export const roster = [
  ['ヴィオレッタ','重騎士','ignore',1],
  ['ノア','捨て身','blood',2],
  ['静流','迎撃','two',2],
  ['イリス','連撃','chase',1],
  ['セレーネ','二択','lunarArts',1],
  ['リカ','札回収','allIn',1],
];
export const cap = 8;
export const limit = 10;
export function fresh(fighters) {
  return fighters.map(id => ({damage:0, heavy:2, counter:2, special:(id===3 || id===4) ? 0 : roster[id][3],
    nick:true, lastAttack:'', attacks:0}));
}
export function attacks(fighters, players, side) {
  const p = players[side];
  const special = roster[fighters[side]][2];
  return [...(p.heavy ? ['heavy'] : []),
    'quick', 'feint',
    ...(special === 'lunarArts' && p.special ? ['lunar','moon'] : []),
    ...(special === 'allIn' && p.special && p.heavy ? ['allIn'] : []),
    ...(p.special && (special === 'ignore'
      || special === 'blood' && p.damage < cap-1
      || special === 'chase') ? [special] : [])];
}
export function defenses(fighters, players, side, phase = "normal") {
  const p = players[side];
  return ['guard', ...(p.counter ? ['counter'] : []),
    ...(phase === 'reveal' ? [] : ['dodge']),
    ...(phase === 'defend' && p.special && p.counter && fighters[side]===2 ? ['two'] : [])];
}
export function possible(fighters, players, attack, defense, side, passiveEffects) {
  const boosted = attack === 'allIn';
  if (boosted) attack = 'heavy';
  const p = players[side];
  const id = fighters[side];
  const guard = defense === 'guard';
  const dodge = defense === 'dodge';
  let own = 0, other = 0;
  switch (attack) {
    case 'ignore': other=2; break;
    case 'blood': own=guard||dodge?2:4; other=dodge?5:guard?4:0; break;
    case 'heavy':
      own=guard||dodge?0:3;
      other=dodge?3:guard?2:0;
      break;
    case 'feint': other=guard||dodge?0:2; break;
    case 'moon': other=guard||dodge?0:4; break;
    case 'lunar': own=guard||dodge?0:3; other=dodge?4:guard?3:0; break;
    case 'quick':
      if (dodge) break;
      other=1;
      if (id===3 && !p.attacks || id===0 && guard && p.nick) {
        other++;
        passiveEffects?.push([side,'与えるダメージ＋1']);
      }
      break;
    case 'chase': other=2; break;
  }
  if (id===1 && guard && p.damage>=5 && (attack==='heavy' || attack==='blood')) {
    other++;
    passiveEffects?.push([side,'与えるダメージ＋1']);
  }
  if (other > 0 && guard && fighters[1-side]===2 && p.lastAttack===attack && attack!=='ignore') {
    other--;
    passiveEffects?.push([1-side,'受けるダメージ−1']);
  }
  if (boosted && other > 0) other++;
  return [own,other];
}
export function resolve(fighters, players, attacker, attack, defense) {
  const receiver = 1-attacker;
  const p = players[attacker];
  const passiveEffects = [];
  const [own,other] = possible(fighters, players, attack, defense, attacker, passiveEffects);
  const strong = attack === 'heavy' || attack === 'allIn';
  const heavyReturned = fighters[attacker] === 5 && strong && other > 0;
  const counterReturned = fighters[receiver] === 5 && defense === 'counter' && own > (attack === 'blood' ? 1 : 0);
  if (strong && !heavyReturned) p.heavy--;
  if (attack === 'allIn') p.special--;
  if (attack === 'ignore' || attack === 'blood' || attack === 'chase' || attack === 'moon' || attack === 'lunar') p.special--;
  p.lastAttack = strong ? 'heavy' : attack;
  const chaseCharge = fighters[attacker] === 3 && attack !== 'chase' && other > 0 && !p.special;
  if (chaseCharge) p.special = 1;
  p.attacks++;
  const moonCharge = fighters[attacker] === 4 && defense === 'guard' && !p.special && attack !== 'lunar';
  if (moonCharge) {
    p.special = 1;
    passiveEffects.push([attacker,'構え札を1枚獲得']);
  }
  if (heavyReturned) passiveEffects.push([attacker,'強襲札を回収']);
  if (counterReturned) passiveEffects.push([receiver,'カウンター札を回収']);
  if (attack === 'quick' && fighters[attacker] === 0 && defense === 'guard') p.nick = false;
  if (defense === 'counter' && !counterReturned) players[receiver].counter--;
  p.damage = Math.min(cap,p.damage+own);
  players[receiver].damage = Math.min(cap,players[receiver].damage+other);
  return {own,other,heavyReturned,counterReturned,chaseCharge,moonCharge,passiveEffects};
}
