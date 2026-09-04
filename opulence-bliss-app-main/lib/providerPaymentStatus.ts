type ProviderPaymentLabelInput = {
  bookingStatus: string;
  paymentStatus?: string | null;
  payoutStatus?: string | null;
  amount?: number | null;
};

export function providerPaymentLabel({
  bookingStatus,
  paymentStatus,
  payoutStatus,
  amount,
}: ProviderPaymentLabelInput) {
  const money =
    amount === null || amount === undefined
      ? "Payment"
      : `£${Number(amount).toFixed(2)}`;

  if (["cancelled", "declined"].includes(bookingStatus)) return "Not payable";

  switch (payoutStatus) {
    case "paid":
      return `${money} paid`;
    case "processing":
      return `${money} payout processing`;
    case "pending":
      return `${money} ready for payout`;
    case "held":
      return `${money} payout held`;
    case "failed":
      return `${money} payout needs attention`;
    case "reversed":
      return `${money} payout reversed`;
    case "not_ready":
      return `${money} held until funding clears`;
  }

  switch (paymentStatus) {
    case "succeeded":
      return `${money} paid`;
    case "capturing":
      return `${money} payment processing`;
    case "capture_failed":
    case "failed":
    case "refund_pending":
    case "partially_refunded":
      return `${money} under review`;
    case "cancelled":
    case "refunded":
      return "Not payable";
    case "authorised":
      return bookingStatus === "in_progress"
        ? `${money} held until checkout`
        : `${money} secured`;
    case "created":
      return `${money} awaiting card hold`;
  }

  if (bookingStatus === "completed") return `${money} awaiting payout`;
  if (bookingStatus === "in_progress") return `${money} held until checkout`;
  return `${money} secured`;
}
