"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, Clock3 } from "lucide-react";
import { londonDateKey, londonParts } from "@/lib/appointmentWindow";

type WheelOption = { id: string; label: string; sublabel?: string };

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Europe/London",
  });
}

function dateLabel(iso: string) {
  const value = new Date(iso);
  const today = londonDateKey(Date.now());
  const tomorrow = londonDateKey(Date.now() + 24 * 60 * 60 * 1000);
  const key = londonDateKey(value);
  const prefix = key === today ? "Today" : key === tomorrow ? "Tomorrow" : "";
  const date = value.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "Europe/London",
  });
  return prefix ? `${prefix} · ${date}` : date;
}

function appointmentRange(iso: string, durationMinutes: number | null) {
  const end = new Date(
    new Date(iso).getTime() + (durationMinutes ?? 120) * 60_000,
  ).toISOString();
  const shortClock = (value: string) =>
    new Date(value)
      .toLocaleTimeString("en-GB", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: "Europe/London",
      })
      .replace(":00", "")
      .toLowerCase();
  return `${shortClock(iso)} – ${shortClock(end)}`;
}

function fullSelection(iso: string) {
  return `${new Date(iso).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "Europe/London",
  })}, ${clock(iso)}`;
}

function Wheel({
  label,
  options,
  value,
  onChange,
  compact = false,
}: {
  label: string;
  options: WheelOption[];
  value: string | null;
  onChange: (id: string) => void;
  compact?: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list || !value) return;
    const selected = list.querySelector<HTMLElement>(`[data-wheel-id="${value}"]`);
    if (!selected) return;
    list.scrollTo({
      top: selected.offsetTop - (list.clientHeight - selected.offsetHeight) / 2,
      behavior: "smooth",
    });
  }, [value, options]);

  function settle() {
    const list = listRef.current;
    if (!list) return;
    const centre = list.scrollTop + list.clientHeight / 2;
    const rows = [...list.querySelectorAll<HTMLElement>("[data-wheel-id]")];
    const nearest = rows.reduce<HTMLElement | null>((best, row) => {
      if (!best) return row;
      const rowDistance = Math.abs(row.offsetTop + row.offsetHeight / 2 - centre);
      const bestDistance = Math.abs(best.offsetTop + best.offsetHeight / 2 - centre);
      return rowDistance < bestDistance ? row : best;
    }, null);
    const id = nearest?.dataset.wheelId;
    if (id && id !== value) onChange(id);
  }

  return (
    <div className={compact ? "wheel compact" : "wheel"}>
      <span className="wheel-label">{label}</span>
      <div className="selection-band" aria-hidden="true" />
      <div
        className="wheel-list"
        ref={listRef}
        role="listbox"
        aria-label={label}
        onScroll={() => {
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(settle, 100);
        }}
      >
        <span className="wheel-space" aria-hidden="true" />
        {options.map((option) => (
          <button
            type="button"
            key={option.id}
            data-wheel-id={option.id}
            role="option"
            aria-selected={value === option.id}
            className={value === option.id ? "wheel-row selected" : "wheel-row"}
            onClick={() => onChange(option.id)}
          >
            <strong>{option.label}</strong>
            {option.sublabel && <small>{option.sublabel}</small>}
          </button>
        ))}
        <span className="wheel-space" aria-hidden="true" />
      </div>
      <style jsx>{`
        .wheel {
          position: relative;
          min-width: 0;
          background: #fff;
        }
        .wheel:first-child {
          border-radius: 14px 0 0 14px;
        }
        .wheel:last-child {
          border-radius: 0 14px 14px 0;
        }
        .wheel-label {
          position: absolute;
          top: 7px;
          left: 0;
          right: 0;
          z-index: 3;
          color: #9a90a6;
          font-size: 9px;
          font-weight: 900;
          letter-spacing: 0.08em;
          text-align: center;
          text-transform: uppercase;
          pointer-events: none;
        }
        .selection-band {
          position: absolute;
          top: 50%;
          left: 5px;
          right: 5px;
          z-index: 1;
          height: 48px;
          border: 1.5px solid #ccb9ee;
          border-radius: 11px;
          background: #f3edff;
          transform: translateY(-50%);
          pointer-events: none;
        }
        .wheel-list {
          position: relative;
          z-index: 2;
          height: 168px;
          overflow-y: auto;
          overscroll-behavior: contain;
          scroll-snap-type: y mandatory;
          scrollbar-width: none;
          mask-image: linear-gradient(
            to bottom,
            transparent,
            #000 24%,
            #000 76%,
            transparent
          );
        }
        .wheel-list::-webkit-scrollbar {
          display: none;
        }
        .wheel-space {
          display: block;
          height: 60px;
        }
        .wheel-row {
          width: 100%;
          height: 48px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          scroll-snap-align: center;
          border: 0;
          background: transparent;
          color: #a29aa9;
          font: inherit;
          cursor: pointer;
        }
        .wheel-row strong {
          max-width: 100%;
          overflow: hidden;
          padding: 0 6px;
          font-size: 14px;
          font-weight: 800;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .wheel.compact .wheel-row strong {
          font-size: 13px;
        }
        .wheel-row small {
          color: inherit;
          font-size: 10px;
        }
        .wheel-row.selected {
          color: #2b2037;
        }
        .wheel-row.selected strong {
          font-size: 15px;
          font-weight: 900;
        }
        @media (max-width: 520px) {
          .wheel-list {
            height: 156px;
          }
          .wheel-space {
            height: 54px;
          }
          .wheel-row {
            height: 48px;
          }
          .wheel-row strong,
          .wheel-row.selected strong {
            font-size: 12.5px;
          }
          .wheel.compact .wheel-row strong {
            font-size: 11.5px;
          }
        }
      `}</style>
    </div>
  );
}

export default function AppointmentTimePicker({
  slots,
  value,
  onChange,
  durationMinutes = 120,
  showDate = true,
}: {
  slots: string[];
  value: string | null;
  onChange: (iso: string) => void;
  durationMinutes?: number | null;
  showDate?: boolean;
}) {
  const dates = useMemo(() => {
    const unique = new Map<string, string>();
    for (const slot of slots) {
      const key = londonDateKey(slot);
      if (!unique.has(key)) unique.set(key, slot);
    }
    return [...unique.entries()];
  }, [slots]);

  const [draftDate, setDraftDate] = useState<string | null>(null);
  const selectedDate = value ? londonDateKey(value) : draftDate ?? dates[0]?.[0];
  const dateSlots = slots.filter((slot) => londonDateKey(slot) === selectedDate);
  const selectedTime =
    value && londonDateKey(value) === selectedDate ? value : null;

  function chooseDate(key: string) {
    setDraftDate(key);
    const currentParts = value ? londonParts(value) : null;
    const replacement = slots.find(
      (slot) => {
        const slotParts = londonParts(slot);
        return (
          londonDateKey(slot) === key &&
          slotParts.hour === currentParts?.hour &&
          slotParts.minute === currentParts?.minute
        );
      },
    ) ?? slots.find((slot) => londonDateKey(slot) === key);
    if (replacement) onChange(replacement);
  }

  const end = value
    ? new Date(new Date(value).getTime() + (durationMinutes ?? 120) * 60_000).toISOString()
    : null;

  return (
    <div className="appointment-picker">
      <div className="picker-title">
        <span>{showDate ? <CalendarDays size={21} /> : <Clock3 size={21} />}</span>
        <div>
          <small>{showDate ? "Select date and time" : "Select a time"}</small>
          <strong>{value ? fullSelection(value) : "Scroll to choose"}</strong>
          {value && end && <b>{clock(value)} – {clock(end)}</b>}
        </div>
      </div>

      <div className={showDate ? "wheels" : "wheels time-only"}>
        {showDate && (
          <Wheel
            label="Date"
            options={dates.map(([key, iso]) => ({ id: key, label: dateLabel(iso) }))}
            value={selectedDate ?? null}
            onChange={chooseDate}
          />
        )}
        <Wheel
          label="Appointment time"
          options={dateSlots.map((slot) => ({
            id: slot,
            label: appointmentRange(slot, durationMinutes),
          }))}
          value={selectedTime}
          onChange={onChange}
        />
      </div>

      <p className="window-note">
        Book online 24/7. Appointments start from 7:00 am and finish by 7:00
        pm; each option shows the full start–finish time. We&apos;ll match the
        professional after you book.
      </p>

      <style jsx>{`
        .appointment-picker { overflow: hidden; border: 1.5px solid #e3dced; border-radius: 21px; background: #fff; box-shadow: 0 12px 34px rgba(45,27,72,.08); }
        .picker-title { display: flex; align-items: center; gap: 12px; padding: 15px 17px; color: #261249; background: linear-gradient(135deg,#f1e9ff,#faf7ff); border-bottom: 1px solid #e8e0f2; }
        .picker-title > span { flex: 0 0 auto; width: 42px; height: 42px; display: grid; place-items: center; border-radius: 13px; color: #6d28d9; background: #fff; box-shadow: 0 5px 15px rgba(109,40,217,.12); }
        .picker-title div { min-width: 0; }
        .picker-title small, .picker-title strong, .picker-title b { display: block; }
        .picker-title small { color: #7a6d8d; font-size: 10.5px; font-weight: 900; letter-spacing: .07em; text-transform: uppercase; }
        .picker-title strong { margin-top: 2px; color: #241b2f; font-size: clamp(18px,3vw,23px); font-weight: 900; line-height: 1.15; }
        .picker-title b { margin-top: 3px; color: #6d28d9; font-size: 12.5px; font-weight: 900; }
        .wheels { display: grid; grid-template-columns: minmax(170px,1fr) minmax(210px,1.25fr); gap: 1px; padding: 12px; background: #eee9f2; }
        .wheels.time-only { grid-template-columns: minmax(250px,1fr); }
        .window-note { margin: 0; padding: 12px 15px 14px; color: #736a7d; font-size: 12px; font-weight: 700; line-height: 1.45; }
        @media (max-width: 520px) {
          .picker-title { padding: 13px; }
          .wheels { grid-template-columns: minmax(0,.9fr) minmax(0,1.1fr); padding: 9px; }
        }
      `}</style>
    </div>
  );
}
