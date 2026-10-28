import { useState } from 'react';
import { DaysTable, useLoad } from '../../components/attendance';
import { Alert, Button, Card, Field, Input, Loading, PageHeader, PersonCell, Table, Td, Th } from '../../components/ui';
import { api, downloadFile, EmployeeRecap, errMsg } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { addDays, todayWIT } from '../../lib/format';

export default function Laporan() {
  const { user } = useAuth();
  const today = todayWIT();
  const [range, setRange] = useState({ from: `${today.slice(0, 7)}-01`, to: today });
  const [month, setMonth] = useState(addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7));
  const [selected, setSelected] = useState<EmployeeRecap | null>(null);
  const [dlError, setDlError] = useState<string | null>(null);
  const { data, error, loading } = useLoad(
    () => api.get<EmployeeRecap[]>(`/monitor/recap?from=${range.from}&to=${range.to}`),
    [range.from, range.to],
  );

  const [busy, setBusy] = useState<string | null>(null);
  const download = (url: string, name: string, key: string) => {
    setDlError(null);
    setBusy(key);
    downloadFile(url, name)
      .catch((e) => setDlError(errMsg(e)))
      .finally(() => setBusy(null));
  };

  return (
    <>
      <PageHeader title="Rekap & Laporan Absensi" />
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 font-semibold">Rekap Operasional (rentang tanggal)</h2>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Dari">
              <Input type="date" value={range.from} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} />
            </Field>
            <Field label="Sampai">
              <Input type="date" value={range.to} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} />
            </Field>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <Button
              icon="fileText"
              loading={busy === 'detail-pdf'}
              onClick={() => download(`/reports/detail.pdf?from=${range.from}&to=${range.to}`, `laporan-kehadiran_${range.from}_${range.to}.pdf`, 'detail-pdf')}
            >
              Unduh PDF
            </Button>
            <Button
              variant="secondary"
              icon="download"
              loading={busy === 'detail-csv'}
              onClick={() => download(`/reports/detail.csv?from=${range.from}&to=${range.to}`, `absensi-detail_${range.from}_${range.to}.csv`, 'detail-csv')}
            >
              Unduh Excel (CSV)
            </Button>
          </div>
          <p className="mt-2 text-xs text-slate-500">PDF berisi ringkasan semua karyawan dan rincian harian per karyawan, termasuk istirahat.</p>
        </Card>
        {user?.role === 'SUPER_ADMIN' && (
          <Card>
            <h2 className="mb-3 font-semibold">Laporan Bulanan Resmi · Manager Mal SMC</h2>
            <Field label="Bulan">
              <Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
            </Field>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <Button
                icon="fileText"
                loading={busy === 'month-pdf'}
                onClick={() => download(`/reports/monthly.pdf?month=${month}`, `rekap-bulanan-SMC_${month}.pdf`, 'month-pdf')}
              >
                Unduh PDF Resmi
              </Button>
              <Button
                variant="secondary"
                icon="download"
                loading={busy === 'month-csv'}
                onClick={() => download(`/reports/monthly.csv?month=${month}`, `rekap-bulanan-SMC_${month}.csv`, 'month-csv')}
              >
                Unduh Excel (CSV)
              </Button>
            </div>
            <p className="mt-2 text-xs text-slate-500">PDF resmi dilengkapi kolom tanda tangan Manager Mal SMC.</p>
          </Card>
        )}
      </div>
      {dlError && <Alert>{dlError}</Alert>}
      {error && <Alert>{error}</Alert>}
      <Card>
        {loading ? (
          <Loading />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Karyawan</Th>
                <Th className="text-center">Hari Kerja</Th>
                <Th className="text-center">Tepat</Th>
                <Th className="text-center">Terlambat</Th>
                <Th className="text-center">Izin</Th>
                <Th className="text-center">Sakit</Th>
                <Th className="text-center">Cuti</Th>
                <Th className="text-center">Alfa</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data?.map((r) => (
                <tr key={r.user.id}>
                  <Td>
                    <PersonCell name={r.user.fullName} sub={r.user.role === 'KOORDINATOR' ? `${r.user.nik} · Koordinator` : r.user.nik} />
                  </Td>
                  <Td className="text-center">{r.summary.hariKerja}</Td>
                  <Td className="text-center text-emerald-700">{r.summary.tepatWaktu}</Td>
                  <Td className="text-center text-amber-700">{r.summary.terlambat}</Td>
                  <Td className="text-center">{r.summary.izin}</Td>
                  <Td className="text-center">{r.summary.sakit}</Td>
                  <Td className="text-center">{r.summary.cuti}</Td>
                  <Td className="text-center font-semibold text-rose-700">{r.summary.alfa}</Td>
                  <Td>
                    <Button variant="ghost" onClick={() => setSelected(selected?.user.id === r.user.id ? null : r)}>
                      {selected?.user.id === r.user.id ? 'Tutup' : 'Detail'}
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {selected && (
        <Card className="mt-4">
          <h2 className="mb-3 font-semibold">Detail · {selected.user.fullName}</h2>
          <DaysTable days={selected.days} />
        </Card>
      )}
    </>
  );
}
