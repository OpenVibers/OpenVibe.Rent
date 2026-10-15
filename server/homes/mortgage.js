'use strict';

/**
 * The mortgage calculator on OpenVibe.Homes: the monthly cost of a fixed-rate loan, from what the person types in.
 * Plain arithmetic (the standard amortisation formula); no rates are fetched or suggested.
 *
 *   monthly({ price, downPercent, ratePercent, years, taxPerYear, insurancePerYear, hoaPerMonth })
 *     → { loan, principalAndInterest, tax, insurance, hoa, total, totalInterest, payments } in dollars, or { error }
 */
const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(String(v).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : NaN;
};
const cents = (n) => Math.round(n * 100) / 100;

function monthly(input) {
    const price = num(input.price);
    const down = num(input.downPercent);
    const rate = num(input.ratePercent);
    const years = num(input.years);
    const tax = num(input.taxPerYear) || 0;
    const ins = num(input.insurancePerYear) || 0;
    const hoa = num(input.hoaPerMonth) || 0;
    if (!(price > 0 && price <= 100_000_000)) return { error: 'Enter the home\'s price.' };
    if (!(down >= 0 && down < 100)) return { error: 'The down payment is a percentage from 0 to 99.' };
    if (!(rate >= 0 && rate <= 30)) return { error: 'The interest rate is a yearly percentage from 0 to 30.' };
    if (![10, 15, 20, 25, 30, 40].includes(years)) return { error: 'Choose a loan term.' };
    if ([tax, ins, hoa].some((x) => Number.isNaN(x) || x < 0 || x > 1_000_000)) return { error: 'Taxes, insurance and HOA are amounts in dollars.' };
    const loan = price * (1 - down / 100);
    const n = years * 12;
    const r = rate / 100 / 12;
    const pi = r === 0 ? loan / n : loan * (r * (1 + r) ** n) / ((1 + r) ** n - 1);
    const total = pi + tax / 12 + ins / 12 + hoa;
    return {
        loan: cents(loan), principalAndInterest: cents(pi), tax: cents(tax / 12), insurance: cents(ins / 12), hoa: cents(hoa),
        total: cents(total), totalInterest: cents(pi * n - loan), payments: n,
    };
}

module.exports = { monthly };
