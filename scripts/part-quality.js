// 选料质量判据（关键）
// 【历史文件】当前流水线不引用它；保留作参考。
// 改回 CommonJS：它曾经在 `scripts\` 下用 `export`，违反 AGENTS.md 第一条禁令。
function judgePart(p) {
  // p: ILIB_DeviceSearchItem
  const props = p.otherProperty || {};
  const lcsc = String(props['Supplier Part'] || '');
  const mfr = String(props['Manufacturer'] || '').trim();
  const ds = String(props['Datasheet'] || '').trim();
  const klass = String(props['JLCPCB Part Class'] || '').trim();
  const fp = String(props['Supplier Footprint'] || '').trim();

  const flags = {
    hasLcsc: /^C\d+$/.test(lcsc),
    isCommunity: /^C99\d{7}$/.test(lcsc),   // 社区上传，通常无厂商/无 datasheet
    hasManufacturer: mfr.length > 0,
    hasDatasheet: ds.length > 0,
    hasJlcpcbClass: klass.length > 0,
    hasFootprint: fp.length > 0,
    isBasic: klass === 'Basic Part',
    hasSymbol: !!p.symbolUuid,
    hasFootprintUuid: !!p.footprintUuid,
  };

  // 可采购性：必须有 LCSC 号 + JLCPCB 分类 + 符号 + 封装
  const purchasable = flags.hasLcsc && flags.hasJlcpcbClass && flags.hasSymbol && flags.hasFootprintUuid;
  // 可信度：真实器件有厂商和 datasheet；社区件两者皆无
  const trustworthy = flags.hasManufacturer || flags.hasDatasheet;
  // 综合评级
  let grade = 'REJECT';
  if (purchasable && trustworthy) grade = flags.isBasic ? 'A' : 'B';
  else if (purchasable && flags.isCommunity) grade = 'C';   // 能用但无溯源，降级

  return { lcsc, mfr, klass, footprint: fp, grade, purchasable, trustworthy, flags };
}

module.exports = { judgePart };
