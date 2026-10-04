"use client";

/**
 * Payer-side i18n for the public Payment Link pages (/pay/[linkId] and the
 * PaymentLinkWidget it mounts).
 *
 * The payer is a stranger with no PayQR account, so the language is not the
 * merchant's saved `payqr.lang`, and there is no picker: it is detected, in order,
 * from
 *   1. their browser / device language, when it is one we translate (hi / pt / es),
 *   2. their country — from the locale's region or, failing that, the device
 *      time zone — mapped to that country's language (not India: see below),
 *   3. English.
 * Nothing is sent anywhere: it all reads from the browser.
 */
import { useCallback, useEffect, useState } from "react";
import type { Lang } from "./i18n";

// ── Country → language ───────────────────────────────────────────────
const REGION_LANG: Record<string, Lang> = {
  // India is deliberately absent: English is widely used there, so an en-IN
  // browser or an Asia/Kolkata time zone stays English. Hindi only when the
  // browser itself is set to Hindi.
  BR: "pt", PT: "pt", AO: "pt", MZ: "pt",
  AR: "es", VE: "es", MX: "es", ES: "es", CO: "es", CL: "es", PE: "es", UY: "es", PY: "es",
  BO: "es", EC: "es", PA: "es", CR: "es", GT: "es", SV: "es", HN: "es", NI: "es", CU: "es", DO: "es",
};

const BR_ZONES = new Set([
  "Sao_Paulo", "Bahia", "Fortaleza", "Manaus", "Recife", "Belem", "Cuiaba", "Campo_Grande", "Noronha",
  "Rio_Branco", "Araguaina", "Maceio", "Porto_Velho", "Boa_Vista", "Santarem", "Eirunepe",
]);
const ES_ZONES = new Set([
  "Caracas", "Mexico_City", "Cancun", "Monterrey", "Merida", "Tijuana", "Bogota", "Lima", "Santiago",
  "Montevideo", "Asuncion", "La_Paz", "Guayaquil", "Panama", "Costa_Rica", "Guatemala", "El_Salvador",
  "Tegucigalpa", "Managua", "Havana", "Santo_Domingo",
]);

function langFromTimeZone(tz: string): Lang | null {
  if (tz === "Europe/Lisbon" || tz.startsWith("Atlantic/Azores") || tz === "Atlantic/Madeira") return "pt";
  if (tz === "Europe/Madrid" || tz === "Atlantic/Canary" || tz === "Africa/Ceuta") return "es";
  const [area, ...rest] = tz.split("/");
  if (area !== "America") return null;
  const city = rest[rest.length - 1] ?? "";
  if (rest[0] === "Argentina" || city === "Buenos_Aires") return "es";
  if (BR_ZONES.has(city)) return "pt";
  if (ES_ZONES.has(city)) return "es";
  return null;
}

/** The language for this payer's browser and country. "en" when nothing matches. */
export function detectPayerLang(): Lang {
  if (typeof navigator === "undefined") return "en";
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
  // A browser set to Hindi/Portuguese/Spanish is the clearest signal.
  for (const tag of tags) {
    const base = String(tag || "").toLowerCase().split("-")[0];
    if (base === "hi" || base === "pt" || base === "es") return base;
  }
  // Otherwise (an English/other browser) go by where the payer is.
  for (const tag of tags) {
    const region = String(tag || "").split("-")[1]?.toUpperCase();
    if (region && REGION_LANG[region]) return REGION_LANG[region];
  }
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const fromZone = tz ? langFromTimeZone(tz) : null;
    if (fromZone) return fromZone;
  } catch {}
  return "en";
}

// ── Dictionaries ─────────────────────────────────────────────────────
// {name} placeholders are filled by t(key, { name }). EN is the fallback.
type Dict = Record<string, string>;

const en: Dict = {
  "pl.btnContinue": "Continue & Pay",
  "pl.paidNoteH": "You must click “I Paid” after successfully completing the payment.",
  "pl.paidNoteSub": "Complete the payment in your banking app, then click I Paid once the payment is successful.",
  "pl.cancel": "Cancel",
  // /pay/[linkId]
  "pl.unavailable": "Payment Links isn't available on this deployment.",
  "pl.loading": "Loading…",
  "pl.retired": "This payment link was made on an earlier version of PayQR and no longer accepts payments. Please ask the merchant for a new link.",
  "pl.notFound": "This payment link doesn't exist.",
  "pl.unverified": "Couldn't verify this link right now.",
  "pl.refresh": "Refresh",
  "pl.revoked": "This payment link has been revoked by the merchant.",
  "pl.expired": "This payment link has expired.",
  "pl.exhausted": "This payment link has already been used the maximum number of times.",
  "pl.outdated": "This payment link is out of date. Please ask the merchant for a new link.",
  "pl.tryAgain": "Try again",
  "pl.errEnterAmount": "Enter a valid amount.",
  "pl.errNoPrice": "Could not price this amount right now. Try again shortly.",
  "pl.errTooSmallMin": "That amount is too small to pay — the minimum is {min}.",
  "pl.errTooSmall": "That amount is too small.",
  "pl.errBusy": "Payments are busy right now. Please try again in a few minutes.",
  "pl.errNoCurrency": "This currency isn't available for payment right now.",
  "pl.errStuck": "{msg} Please don't pay again. If it doesn't complete, contact support with this reference: {ref}",
  "pl.errPrepare": "Could not prepare this payment. Please try again.",
  "pl.overCap": "This shop can accept up to {max} in one payment.",
  "pl.sentConfirming": "Your payment was sent and is being confirmed. Please keep this page open and don't pay again.",
  "pl.btnConfirming": "Confirming your payment…",
  "pl.btnPreparing": "Preparing your payment…",
  "pl.btnChecking": "Checking link…",
  "pl.btnTooHigh": "Amount too high",
  "pl.btnEnter": "Enter an amount",
  "pl.privacy": "To help keep payments safe, we check basic device details (like browser and screen size) when you pay.",
  // payment screen
  "pl.settingUp": "Setting up your payment…",
  "pl.fewSeconds": "This usually takes a few seconds.",
  "pl.dontPay": "Please don't pay",
  "pl.mismatchSub": "We couldn't confirm this payment belongs to this link. Nothing has been charged.",
  "pl.contactSupport": "Contact support ↗",
  "pl.detailsUnavailable": "Payment details unavailable",
  "pl.detailsUnavailableSub": "We couldn't open the payment details on this device. Please don't pay yet — contact support.",
  "pl.gettingDetails": "Getting payment details…",
  "pl.paymentDetails": "Payment details",
  "pl.amount": "Amount",
  "pl.confirming": "Confirming…",
  "pl.ivePaid": "I Paid",
  "pl.cancelOrder": "Cancel order",
  "pl.verifying": "Verifying your payment",
  "pl.verifyingSub": "Confirming receipt. Usually under a minute.",
  "pl.cancelQ": "Cancel this order?",
  "pl.cancelQSub": "If you've already paid, don't cancel — wait for confirmation instead.",
  "pl.keepOrder": "Keep order",
  "pl.yesCancel": "Yes, cancel",
  "pl.waiting": "Waiting for payment",
  "pl.reviewNote": "Your payment is being reviewed by our support team. This page will update when it's done.",
  "pl.errMarkPaid": "Couldn't confirm this payment. Please try again.",
  "pl.errCancel": "Couldn't cancel this order. Please try again.",
  "pl.scanToPay": "Scan to pay",
  "pl.scanHintApp": "Scan this QR with your banking or payment app",
  "pl.scanHintBank": "Scan this QR code with your banking app",
  "pl.payUpi": "Pay with UPI",
  "pl.openUpi": "Open UPI app",
  "pl.payPix": "Pay with Pix",
  "pl.pixSub": "Send the amount below to the Pix key shown, from your bank app.",
  "pl.pixScanHint": "Scan this Pix QR in your bank app",
  "pl.pixCopia": "Or pay with Pix Copia e Cola",
  "pl.codeCopied": "Code copied",
  "pl.copyPix": "Copy Pix code",
  "pl.bankTransfer": "Bank transfer",
  "pl.bankTransferSub": "Send the {currency} amount below using your banking app.",
  "pl.copy": "Copy {label}",
  // receipts
  "pl.rcptSuccess": "Payment successful",
  "pl.paidToShop": "Paid to {name}",
  "pl.youPaid": "You paid",
  "pl.paidTo": "Paid to",
  "pl.via": "Via",
  "pl.when": "When",
  "pl.receiptNo": "Receipt no.",
  "pl.status": "Status",
  "pl.underReview": "Under review",
  "pl.completed": "Completed",
  "pl.saveReceipt": "Save this receipt as proof of your payment.",
  "pl.preparingImage": "Preparing image…",
  "pl.shareImage": "Share as image",
  "pl.newPayment": "New payment",
  "pl.reportIssue": "Something wrong with this payment? Report an issue ↗",
  "pl.windowEnded": "Payment window ended",
  "pl.payCancelled": "Payment cancelled",
  "pl.cancelledStatus": "Cancelled",
  "pl.noPayAgain": "Please don't pay again.",
  "pl.ifAlreadyPaid": "If you already paid, tap “I already paid” — don't pay again.",
  "pl.didNotGoThrough": "This payment did not go through",
  "pl.needHelp": "Need help with this order?",
  "pl.helpSub": "Tap below to open PayQR support. Your order details are filled in and copied — if the chat opens empty, just paste them.",
  "pl.getHelp": "Get help on this order ↗",
  "pl.working": "Working…",
  "pl.alreadyPaid": "I already paid",
};

const hi: Dict = {
  "pl.btnContinue": "आगे बढ़ें और भुगतान करें",
  "pl.paidNoteH": "भुगतान सफलतापूर्वक पूरा करने के बाद आपको “मैंने भुगतान कर दिया” दबाना ज़रूरी है।",
  "pl.paidNoteSub": "अपने बैंकिंग ऐप में भुगतान पूरा करें, फिर भुगतान सफल होने के बाद “मैंने भुगतान कर दिया” दबाएँ।",
  "pl.cancel": "रद्द करें",
  "pl.unavailable": "इस डिप्लॉयमेंट पर पेमेंट लिंक उपलब्ध नहीं है।",
  "pl.loading": "लोड हो रहा है…",
  "pl.retired": "यह पेमेंट लिंक PayQR के पुराने संस्करण पर बना था और अब भुगतान स्वीकार नहीं करता। कृपया मर्चेंट से नया लिंक माँगें।",
  "pl.notFound": "यह पेमेंट लिंक मौजूद नहीं है।",
  "pl.unverified": "अभी इस लिंक की पुष्टि नहीं हो सकी।",
  "pl.refresh": "रीफ़्रेश करें",
  "pl.revoked": "मर्चेंट ने इस पेमेंट लिंक को रद्द कर दिया है।",
  "pl.expired": "इस पेमेंट लिंक की समय-सीमा समाप्त हो गई है।",
  "pl.exhausted": "यह पेमेंट लिंक अधिकतम बार उपयोग किया जा चुका है।",
  "pl.outdated": "यह पेमेंट लिंक पुराना हो चुका है। कृपया मर्चेंट से नया लिंक माँगें।",
  "pl.tryAgain": "फिर कोशिश करें",
  "pl.errEnterAmount": "सही राशि दर्ज करें।",
  "pl.errNoPrice": "अभी इस राशि की कीमत तय नहीं हो सकी। थोड़ी देर में फिर कोशिश करें।",
  "pl.errTooSmallMin": "यह राशि भुगतान के लिए बहुत कम है — न्यूनतम {min} है।",
  "pl.errTooSmall": "यह राशि बहुत कम है।",
  "pl.errBusy": "अभी भुगतान में बहुत भीड़ है। कृपया कुछ मिनट बाद फिर कोशिश करें।",
  "pl.errNoCurrency": "यह मुद्रा अभी भुगतान के लिए उपलब्ध नहीं है।",
  "pl.errStuck": "{msg} कृपया दोबारा भुगतान न करें। अगर यह पूरा न हो, तो इस रेफ़रेंस के साथ सपोर्ट से संपर्क करें: {ref}",
  "pl.errPrepare": "इस भुगतान को तैयार नहीं किया जा सका। कृपया फिर कोशिश करें।",
  "pl.overCap": "यह दुकान एक भुगतान में अधिकतम {max} स्वीकार कर सकती है।",
  "pl.sentConfirming": "आपका भुगतान भेज दिया गया है और उसकी पुष्टि हो रही है। कृपया यह पेज खुला रखें और दोबारा भुगतान न करें।",
  "pl.btnConfirming": "आपके भुगतान की पुष्टि हो रही है…",
  "pl.btnPreparing": "आपका भुगतान तैयार हो रहा है…",
  "pl.btnChecking": "लिंक जाँचा जा रहा है…",
  "pl.btnTooHigh": "राशि बहुत अधिक है",
  "pl.btnEnter": "राशि दर्ज करें",
  "pl.privacy": "भुगतानों को सुरक्षित रखने के लिए, भुगतान करते समय हम डिवाइस की बुनियादी जानकारी (जैसे ब्राउज़र और स्क्रीन का आकार) जाँचते हैं।",
  "pl.settingUp": "आपका भुगतान तैयार किया जा रहा है…",
  "pl.fewSeconds": "इसमें आमतौर पर कुछ सेकंड लगते हैं।",
  "pl.dontPay": "कृपया भुगतान न करें",
  "pl.mismatchSub": "हम पुष्टि नहीं कर सके कि यह भुगतान इसी लिंक का है। कुछ भी चार्ज नहीं हुआ है।",
  "pl.contactSupport": "सपोर्ट से संपर्क करें ↗",
  "pl.detailsUnavailable": "भुगतान विवरण उपलब्ध नहीं",
  "pl.detailsUnavailableSub": "हम इस डिवाइस पर भुगतान विवरण नहीं खोल सके। कृपया अभी भुगतान न करें — सपोर्ट से संपर्क करें।",
  "pl.gettingDetails": "भुगतान विवरण लाए जा रहे हैं…",
  "pl.paymentDetails": "भुगतान विवरण",
  "pl.amount": "राशि",
  "pl.confirming": "पुष्टि हो रही है…",
  "pl.ivePaid": "मैंने भुगतान कर दिया",
  "pl.cancelOrder": "ऑर्डर रद्द करें",
  "pl.verifying": "आपके भुगतान की जाँच हो रही है",
  "pl.verifyingSub": "रसीद की पुष्टि हो रही है। आमतौर पर एक मिनट से कम लगता है।",
  "pl.cancelQ": "यह ऑर्डर रद्द करें?",
  "pl.cancelQSub": "अगर आप भुगतान कर चुके हैं, तो रद्द न करें — इसके बजाय पुष्टि का इंतज़ार करें।",
  "pl.keepOrder": "ऑर्डर रखें",
  "pl.yesCancel": "हाँ, रद्द करें",
  "pl.waiting": "भुगतान की प्रतीक्षा",
  "pl.reviewNote": "हमारी सपोर्ट टीम आपके भुगतान की समीक्षा कर रही है। पूरा होने पर यह पेज अपडेट हो जाएगा।",
  "pl.errMarkPaid": "इस भुगतान की पुष्टि नहीं हो सकी। कृपया फिर कोशिश करें।",
  "pl.errCancel": "यह ऑर्डर रद्द नहीं हो सका। कृपया फिर कोशिश करें।",
  "pl.scanToPay": "भुगतान के लिए स्कैन करें",
  "pl.scanHintApp": "इस QR को अपने बैंकिंग या पेमेंट ऐप से स्कैन करें",
  "pl.scanHintBank": "इस QR कोड को अपने बैंकिंग ऐप से स्कैन करें",
  "pl.payUpi": "UPI से भुगतान करें",
  "pl.openUpi": "UPI ऐप खोलें",
  "pl.payPix": "Pix से भुगतान करें",
  "pl.pixSub": "नीचे दी गई राशि अपने बैंक ऐप से दिखाई गई Pix कुंजी पर भेजें।",
  "pl.pixScanHint": "इस Pix QR को अपने बैंक ऐप में स्कैन करें",
  "pl.pixCopia": "या Pix Copia e Cola से भुगतान करें",
  "pl.codeCopied": "कोड कॉपी हो गया",
  "pl.copyPix": "Pix कोड कॉपी करें",
  "pl.bankTransfer": "बैंक ट्रांसफ़र",
  "pl.bankTransferSub": "नीचे दी गई {currency} राशि अपने बैंकिंग ऐप से भेजें।",
  "pl.copy": "{label} कॉपी करें",
  "pl.rcptSuccess": "भुगतान सफल",
  "pl.paidToShop": "{name} को भुगतान किया",
  "pl.youPaid": "आपने भुगतान किया",
  "pl.paidTo": "इन्हें भुगतान",
  "pl.via": "माध्यम",
  "pl.when": "कब",
  "pl.receiptNo": "रसीद संख्या",
  "pl.status": "स्थिति",
  "pl.underReview": "समीक्षा में",
  "pl.completed": "पूर्ण",
  "pl.saveReceipt": "अपने भुगतान के प्रमाण के रूप में यह रसीद सहेजें।",
  "pl.preparingImage": "इमेज बन रही है…",
  "pl.shareImage": "इमेज के रूप में शेयर करें",
  "pl.newPayment": "नया भुगतान",
  "pl.reportIssue": "इस भुगतान में कुछ गड़बड़ है? समस्या बताएँ ↗",
  "pl.windowEnded": "भुगतान का समय समाप्त",
  "pl.payCancelled": "भुगतान रद्द हुआ",
  "pl.cancelledStatus": "रद्द",
  "pl.noPayAgain": "कृपया दोबारा भुगतान न करें।",
  "pl.ifAlreadyPaid": "अगर आप भुगतान कर चुके हैं, तो “मैंने भुगतान कर दिया” दबाएँ — दोबारा भुगतान न करें।",
  "pl.didNotGoThrough": "यह भुगतान पूरा नहीं हुआ",
  "pl.needHelp": "इस ऑर्डर में मदद चाहिए?",
  "pl.helpSub": "PayQR सपोर्ट खोलने के लिए नीचे टैप करें। आपके ऑर्डर का विवरण भरा और कॉपी किया हुआ है — अगर चैट खाली खुले, तो बस उसे पेस्ट कर दें।",
  "pl.getHelp": "इस ऑर्डर पर मदद पाएँ ↗",
  "pl.working": "प्रोसेस हो रहा है…",
  "pl.alreadyPaid": "मैं पहले ही भुगतान कर चुका हूँ",
};

const pt: Dict = {
  "pl.btnContinue": "Continuar e pagar",
  "pl.paidNoteH": "Você deve clicar em “Já paguei” depois de concluir o pagamento com sucesso.",
  "pl.paidNoteSub": "Conclua o pagamento no app do seu banco e, quando ele for confirmado, clique em Já paguei.",
  "pl.cancel": "Cancelar",
  "pl.unavailable": "Links de pagamento não estão disponíveis nesta implantação.",
  "pl.loading": "Carregando…",
  "pl.retired": "Este link de pagamento foi criado em uma versão anterior do PayQR e não aceita mais pagamentos. Peça um novo link ao lojista.",
  "pl.notFound": "Este link de pagamento não existe.",
  "pl.unverified": "Não foi possível verificar este link agora.",
  "pl.refresh": "Atualizar",
  "pl.revoked": "Este link de pagamento foi revogado pelo lojista.",
  "pl.expired": "Este link de pagamento expirou.",
  "pl.exhausted": "Este link de pagamento já foi usado o número máximo de vezes.",
  "pl.outdated": "Este link de pagamento está desatualizado. Peça um novo link ao lojista.",
  "pl.tryAgain": "Tentar novamente",
  "pl.errEnterAmount": "Digite um valor válido.",
  "pl.errNoPrice": "Não foi possível precificar este valor agora. Tente novamente em instantes.",
  "pl.errTooSmallMin": "Esse valor é pequeno demais para pagar — o mínimo é {min}.",
  "pl.errTooSmall": "Esse valor é pequeno demais.",
  "pl.errBusy": "Os pagamentos estão congestionados agora. Tente novamente em alguns minutos.",
  "pl.errNoCurrency": "Esta moeda não está disponível para pagamento no momento.",
  "pl.errStuck": "{msg} Não pague novamente. Se não for concluído, fale com o suporte informando esta referência: {ref}",
  "pl.errPrepare": "Não foi possível preparar este pagamento. Tente novamente.",
  "pl.overCap": "Esta loja aceita até {max} em um único pagamento.",
  "pl.sentConfirming": "Seu pagamento foi enviado e está sendo confirmado. Mantenha esta página aberta e não pague novamente.",
  "pl.btnConfirming": "Confirmando seu pagamento…",
  "pl.btnPreparing": "Preparando seu pagamento…",
  "pl.btnChecking": "Verificando o link…",
  "pl.btnTooHigh": "Valor muito alto",
  "pl.btnEnter": "Digite um valor",
  "pl.privacy": "Para manter os pagamentos seguros, verificamos informações básicas do dispositivo (como navegador e tamanho da tela) quando você paga.",
  "pl.settingUp": "Preparando seu pagamento…",
  "pl.fewSeconds": "Isso costuma levar alguns segundos.",
  "pl.dontPay": "Por favor, não pague",
  "pl.mismatchSub": "Não conseguimos confirmar que este pagamento pertence a este link. Nada foi cobrado.",
  "pl.contactSupport": "Falar com o suporte ↗",
  "pl.detailsUnavailable": "Dados de pagamento indisponíveis",
  "pl.detailsUnavailableSub": "Não conseguimos abrir os dados de pagamento neste dispositivo. Não pague ainda — fale com o suporte.",
  "pl.gettingDetails": "Obtendo os dados de pagamento…",
  "pl.paymentDetails": "Dados do pagamento",
  "pl.amount": "Valor",
  "pl.confirming": "Confirmando…",
  "pl.ivePaid": "Já paguei",
  "pl.cancelOrder": "Cancelar pedido",
  "pl.verifying": "Verificando seu pagamento",
  "pl.verifyingSub": "Confirmando o recebimento. Geralmente leva menos de um minuto.",
  "pl.cancelQ": "Cancelar este pedido?",
  "pl.cancelQSub": "Se você já pagou, não cancele — aguarde a confirmação.",
  "pl.keepOrder": "Manter pedido",
  "pl.yesCancel": "Sim, cancelar",
  "pl.waiting": "Aguardando pagamento",
  "pl.reviewNote": "Seu pagamento está sendo analisado pela nossa equipe de suporte. Esta página será atualizada quando terminar.",
  "pl.errMarkPaid": "Não foi possível confirmar este pagamento. Tente novamente.",
  "pl.errCancel": "Não foi possível cancelar este pedido. Tente novamente.",
  "pl.scanToPay": "Escaneie para pagar",
  "pl.scanHintApp": "Escaneie este QR com seu app de banco ou de pagamento",
  "pl.scanHintBank": "Escaneie este QR code com seu app do banco",
  "pl.payUpi": "Pagar com UPI",
  "pl.openUpi": "Abrir app UPI",
  "pl.payPix": "Pagar com Pix",
  "pl.pixSub": "Envie o valor abaixo para a chave Pix indicada, pelo app do seu banco.",
  "pl.pixScanHint": "Escaneie este QR Pix no app do seu banco",
  "pl.pixCopia": "Ou pague com Pix Copia e Cola",
  "pl.codeCopied": "Código copiado",
  "pl.copyPix": "Copiar código Pix",
  "pl.bankTransfer": "Transferência bancária",
  "pl.bankTransferSub": "Envie o valor em {currency} abaixo pelo app do seu banco.",
  "pl.copy": "Copiar {label}",
  "pl.rcptSuccess": "Pagamento realizado",
  "pl.paidToShop": "Pago a {name}",
  "pl.youPaid": "Você pagou",
  "pl.paidTo": "Pago a",
  "pl.via": "Via",
  "pl.when": "Quando",
  "pl.receiptNo": "Nº do recibo",
  "pl.status": "Status",
  "pl.underReview": "Em análise",
  "pl.completed": "Concluído",
  "pl.saveReceipt": "Guarde este recibo como comprovante do seu pagamento.",
  "pl.preparingImage": "Preparando imagem…",
  "pl.shareImage": "Compartilhar como imagem",
  "pl.newPayment": "Novo pagamento",
  "pl.reportIssue": "Algo errado com este pagamento? Relatar um problema ↗",
  "pl.windowEnded": "Prazo de pagamento encerrado",
  "pl.payCancelled": "Pagamento cancelado",
  "pl.cancelledStatus": "Cancelado",
  "pl.noPayAgain": "Por favor, não pague novamente.",
  "pl.ifAlreadyPaid": "Se você já pagou, toque em “Já paguei” — não pague novamente.",
  "pl.didNotGoThrough": "Este pagamento não foi concluído",
  "pl.needHelp": "Precisa de ajuda com este pedido?",
  "pl.helpSub": "Toque abaixo para abrir o suporte do PayQR. Os dados do seu pedido já estão preenchidos e copiados — se o chat abrir vazio, basta colar.",
  "pl.getHelp": "Obter ajuda com este pedido ↗",
  "pl.working": "Processando…",
  "pl.alreadyPaid": "Já paguei",
};

const es: Dict = {
  "pl.btnContinue": "Continuar y pagar",
  "pl.paidNoteH": "Debes hacer clic en “Ya pagué” después de completar el pago con éxito.",
  "pl.paidNoteSub": "Completa el pago en tu app bancaria y, cuando se confirme, haz clic en Ya pagué.",
  "pl.cancel": "Cancelar",
  "pl.unavailable": "Los enlaces de pago no están disponibles en esta implementación.",
  "pl.loading": "Cargando…",
  "pl.retired": "Este enlace de pago se creó en una versión anterior de PayQR y ya no acepta pagos. Pide un enlace nuevo al comercio.",
  "pl.notFound": "Este enlace de pago no existe.",
  "pl.unverified": "No se pudo verificar este enlace en este momento.",
  "pl.refresh": "Actualizar",
  "pl.revoked": "El comercio revocó este enlace de pago.",
  "pl.expired": "Este enlace de pago ha vencido.",
  "pl.exhausted": "Este enlace de pago ya se usó el máximo de veces.",
  "pl.outdated": "Este enlace de pago está desactualizado. Pide un enlace nuevo al comercio.",
  "pl.tryAgain": "Intentar de nuevo",
  "pl.errEnterAmount": "Ingresa un monto válido.",
  "pl.errNoPrice": "No se pudo cotizar este monto ahora. Inténtalo de nuevo en breve.",
  "pl.errTooSmallMin": "Ese monto es demasiado pequeño para pagar — el mínimo es {min}.",
  "pl.errTooSmall": "Ese monto es demasiado pequeño.",
  "pl.errBusy": "Los pagos están saturados ahora. Inténtalo de nuevo en unos minutos.",
  "pl.errNoCurrency": "Esta moneda no está disponible para pagos en este momento.",
  "pl.errStuck": "{msg} No pagues de nuevo. Si no se completa, contacta a soporte con esta referencia: {ref}",
  "pl.errPrepare": "No se pudo preparar este pago. Inténtalo de nuevo.",
  "pl.overCap": "Este comercio acepta hasta {max} en un solo pago.",
  "pl.sentConfirming": "Tu pago fue enviado y se está confirmando. Mantén esta página abierta y no pagues de nuevo.",
  "pl.btnConfirming": "Confirmando tu pago…",
  "pl.btnPreparing": "Preparando tu pago…",
  "pl.btnChecking": "Verificando el enlace…",
  "pl.btnTooHigh": "Monto demasiado alto",
  "pl.btnEnter": "Ingresa un monto",
  "pl.privacy": "Para mantener los pagos seguros, revisamos datos básicos del dispositivo (como el navegador y el tamaño de pantalla) cuando pagas.",
  "pl.settingUp": "Preparando tu pago…",
  "pl.fewSeconds": "Normalmente toma unos segundos.",
  "pl.dontPay": "Por favor, no pagues",
  "pl.mismatchSub": "No pudimos confirmar que este pago pertenece a este enlace. No se ha cobrado nada.",
  "pl.contactSupport": "Contactar a soporte ↗",
  "pl.detailsUnavailable": "Datos de pago no disponibles",
  "pl.detailsUnavailableSub": "No pudimos abrir los datos de pago en este dispositivo. No pagues todavía — contacta a soporte.",
  "pl.gettingDetails": "Obteniendo los datos de pago…",
  "pl.paymentDetails": "Datos de pago",
  "pl.amount": "Monto",
  "pl.confirming": "Confirmando…",
  "pl.ivePaid": "Ya pagué",
  "pl.cancelOrder": "Cancelar pedido",
  "pl.verifying": "Verificando tu pago",
  "pl.verifyingSub": "Confirmando la recepción. Normalmente tarda menos de un minuto.",
  "pl.cancelQ": "¿Cancelar este pedido?",
  "pl.cancelQSub": "Si ya pagaste, no canceles — espera la confirmación.",
  "pl.keepOrder": "Mantener pedido",
  "pl.yesCancel": "Sí, cancelar",
  "pl.waiting": "Esperando el pago",
  "pl.reviewNote": "Nuestro equipo de soporte está revisando tu pago. Esta página se actualizará cuando termine.",
  "pl.errMarkPaid": "No se pudo confirmar este pago. Inténtalo de nuevo.",
  "pl.errCancel": "No se pudo cancelar este pedido. Inténtalo de nuevo.",
  "pl.scanToPay": "Escanea para pagar",
  "pl.scanHintApp": "Escanea este QR con tu app bancaria o de pagos",
  "pl.scanHintBank": "Escanea este código QR con tu app bancaria",
  "pl.payUpi": "Pagar con UPI",
  "pl.openUpi": "Abrir app UPI",
  "pl.payPix": "Pagar con Pix",
  "pl.pixSub": "Envía el monto de abajo a la clave Pix indicada, desde la app de tu banco.",
  "pl.pixScanHint": "Escanea este QR Pix en la app de tu banco",
  "pl.pixCopia": "O paga con Pix Copia e Cola",
  "pl.codeCopied": "Código copiado",
  "pl.copyPix": "Copiar código Pix",
  "pl.bankTransfer": "Transferencia bancaria",
  "pl.bankTransferSub": "Envía el monto en {currency} de abajo desde tu app bancaria.",
  "pl.copy": "Copiar {label}",
  "pl.rcptSuccess": "Pago exitoso",
  "pl.paidToShop": "Pagado a {name}",
  "pl.youPaid": "Pagaste",
  "pl.paidTo": "Pagado a",
  "pl.via": "Vía",
  "pl.when": "Cuándo",
  "pl.receiptNo": "N.º de recibo",
  "pl.status": "Estado",
  "pl.underReview": "En revisión",
  "pl.completed": "Completado",
  "pl.saveReceipt": "Guarda este recibo como comprobante de tu pago.",
  "pl.preparingImage": "Preparando imagen…",
  "pl.shareImage": "Compartir como imagen",
  "pl.newPayment": "Nuevo pago",
  "pl.reportIssue": "¿Algo salió mal con este pago? Reportar un problema ↗",
  "pl.windowEnded": "Terminó el plazo de pago",
  "pl.payCancelled": "Pago cancelado",
  "pl.cancelledStatus": "Cancelado",
  "pl.noPayAgain": "Por favor, no pagues de nuevo.",
  "pl.ifAlreadyPaid": "Si ya pagaste, toca “Ya pagué” — no pagues de nuevo.",
  "pl.didNotGoThrough": "Este pago no se completó",
  "pl.needHelp": "¿Necesitas ayuda con este pedido?",
  "pl.helpSub": "Toca abajo para abrir el soporte de PayQR. Los datos de tu pedido ya están completos y copiados — si el chat se abre vacío, solo pégalos.",
  "pl.getHelp": "Obtener ayuda con este pedido ↗",
  "pl.working": "Procesando…",
  "pl.alreadyPaid": "Ya pagué",
};

const DICTS: Record<Lang, Dict> = { en, hi, pt, es };

export type PayerT = (key: string, vars?: Record<string, string | number>) => string;

export function payerTranslate(key: string, lang: Lang, vars?: Record<string, string | number>): string {
  const raw = DICTS[lang]?.[key] ?? en[key] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : raw;
}

/** BCP-47 locale for dates, matching the payer's language. */
export const PAYER_DATE_LOCALE: Record<Lang, string> = { en: "en", hi: "hi-IN", pt: "pt-BR", es: "es" };

/**
 * { t, lang } for the payer pages. Starts in English for the server render,
 * then switches to the language detected from the browser and country.
 */
export function usePayerT() {
  const [lang, setLang] = useState<Lang>("en");
  useEffect(() => { setLang(detectPayerLang()); }, []);
  const t = useCallback<PayerT>((key, vars) => payerTranslate(key, lang, vars), [lang]);
  return { t, lang };
}
