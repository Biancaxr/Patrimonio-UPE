import { useEffect, useMemo, useRef, useState } from "react";
import JsBarcode from "jsbarcode";
import { strToU8, zipSync } from "fflate";
import type { IScannerControls } from "@zxing/browser";
import {
  ArrowLeftRight,
  BarChart3,
  Bell,
  Bot,
  Boxes,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  Clock3,
  Download,
  FileBarChart,
  Filter,
  Gauge,
  History,
  Home,
  Layers3,
  LogIn,
  LogOut,
  Map,
  Menu,
  PackageCheck,
  Plus,
  RotateCcw,
  ScanLine,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  UserRound,
  Users,
  Wrench,
  X,
  AlertTriangle,
  Eye,
  Pencil,
  Barcode,
  CalendarDays,
  ListChecks,
  MapPin,
  MessageSquareWarning,
  Send,
} from "lucide-react";
import { clearStore, loadStore, saveStore, seedAssets } from "./data";
import { api, apiLogin, clearApiSession, hasApi, loadRemoteStore, type ApiRole, type ApiUser } from "./api";
import type {
  Asset,
  AssetStatus,
  ChecklistTemplate,
  Inspection,
  Loan,
  Maintenance,
  Movement,
  SupportTicket,
  TicketStatus,
} from "./types";

type UserRole = "admin" | "nti" | "student" | "administration";

interface SessionUser {
  id?: string;
  name: string;
  email: string;
  role: UserRole;
  label: string;
  initials: string;
}

const USERS: Record<UserRole, SessionUser> = {
  admin: { name: "Dircel", email: "admin@upe.br", role: "admin", label: "Administrador", initials: "DI" },
  nti: { name: "Equipe NTI", email: "nti@upe.br", role: "nti", label: "NTI", initials: "NT" },
  student: { name: "Aluno vistoriador", email: "aluno@upe.br", role: "student", label: "Apoio à vistoria", initials: "AL" },
  administration: { name: "Administração", email: "administracao@upe.br", role: "administration", label: "Administração", initials: "AD" },
};

const apiRoleToSession: Record<ApiRole, UserRole> = { ADMIN: "admin", TI: "nti", ALUNO: "student", ADMINISTRACAO: "administration" };
const sessionFromApi = (account: ApiUser): SessionUser => ({ id: account.id, name: account.name, email: account.email, role: apiRoleToSession[account.role], label: account.role === "ADMIN" ? "Administrador" : account.role === "TI" ? "TI" : account.role === "ALUNO" ? "Aluno" : "Administração", initials: account.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() });

type Page =
  | "dashboard"
  | "assets"
  | "map"
  | "inventory"
  | "movements"
  | "loans"
  | "maintenance"
  | "inspections"
  | "create-ticket"
  | "tickets"
  | "reports"
  | "chat"
  | "users"
  | "settings";

const fmt = new Intl.NumberFormat("pt-BR");
const currency = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
const date = (value: string) =>
  new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));

const safeDownloadName = (value: string) => {
  const normalized = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  return normalized || "arquivo";
};

const normalizeBarcode = (value: string) =>
  value
    .trim()
    .replace(/^\][A-Za-z][0-9]/, "")
    .normalize("NFKC")
    .replace(/[^0-9a-z]/gi, "")
    .toLowerCase();

const findAssetByBarcode = (assets: Asset[], value: string) => {
  const normalized = normalizeBarcode(value);
  if (!normalized) return undefined;
  return assets.find(
    (asset) =>
      normalizeBarcode(asset.code) === normalized ||
      normalizeBarcode(asset.serial) === normalized,
  );
};

interface NativeBarcodeDetector {
  detect(source: HTMLVideoElement | HTMLCanvasElement): Promise<Array<{ rawValue: string }>>;
}

interface NativeBarcodeDetectorConstructor {
  new (): NativeBarcodeDetector;
}

const getNativeBarcodeDetector = () =>
  (globalThis as typeof globalThis & {
    BarcodeDetector?: NativeBarcodeDetectorConstructor;
  }).BarcodeDetector;

const describeBarcodeError = (error: unknown) => {
  const candidate = error as {
    name?: string;
    message?: string;
    getKind?: () => string;
    constructor?: { name?: string };
  };
  const kind = candidate?.getKind?.() || candidate?.name || candidate?.constructor?.name || "Erro desconhecido";
  if (/NotFound/i.test(kind)) return "nenhum padrão de barras detectável neste quadro";
  if (/Format/i.test(kind)) return "padrão localizado, mas o formato não pôde ser validado";
  if (/Checksum/i.test(kind)) return "código localizado, mas o dígito verificador é inválido";
  return candidate?.message ? `${kind}: ${candidate.message}` : kind;
};

interface NativeImageCapture {
  takePhoto(): Promise<Blob>;
}

interface NativeImageCaptureConstructor {
  new (track: MediaStreamTrack): NativeImageCapture;
}

let quaggaDecodeQueue: Promise<void> = Promise.resolve();

const decodeSourceWithQuagga = (source: string) => {
  const task = quaggaDecodeQueue.then(async () => {
    const { default: Quagga } = await import("@ericblade/quagga2");
    const result = await Quagga.decodeSingle({
      src: source,
      numOfWorkers: 0,
      locate: true,
      inputStream: {
        size: 0,
        singleChannel: false,
        willReadFrequently: true,
      },
      locator: {
        halfSample: false,
        patchSize: "medium",
        willReadFrequently: true,
      },
      decoder: {
        readers: [
          "ean_reader",
          "ean_8_reader",
          "upc_reader",
          "upc_e_reader",
          "code_128_reader",
          "code_39_reader",
          "code_93_reader",
          "codabar_reader",
          "i2of5_reader",
          "2of5_reader",
        ],
        multiple: false,
      },
    });
    return result?.codeResult?.code?.trim() || null;
  });
  quaggaDecodeQueue = task.then(() => undefined, () => undefined);
  return task;
};

const decodeCanvasWithQuagga = (canvas: HTMLCanvasElement) =>
  decodeSourceWithQuagga(canvas.toDataURL("image/jpeg", 0.96));

const decodeFileWithQuagga = async (file: File) => {
  const source = URL.createObjectURL(file);
  try {
    return await decodeSourceWithQuagga(source);
  } finally {
    URL.revokeObjectURL(source);
  }
};

const decodeVideoFrameWithQuagga = async (video: HTMLVideoElement) => {
  if (!video.videoWidth || !video.videoHeight) return null;
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 1280 / video.videoWidth);
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.getContext("2d", { willReadFrequently: true })?.drawImage(video, 0, 0, canvas.width, canvas.height);
  return decodeCanvasWithQuagga(canvas);
};

const captureBarcodePhoto = async (
  video: HTMLVideoElement,
  reportDiagnostic?: (message: string) => void,
) => {
  if (!video.videoWidth || !video.videoHeight) {
    throw new Error("A câmera ainda está preparando a imagem. Tente novamente em um instante.");
  }

  const source = document.createElement("canvas");
  let bitmap: ImageBitmap | null = null;
  const stream = video.srcObject instanceof MediaStream ? video.srcObject : null;
  const ImageCaptureApi = (globalThis as typeof globalThis & {
    ImageCapture?: NativeImageCaptureConstructor;
  }).ImageCapture;

  if (ImageCaptureApi && stream?.getVideoTracks()[0] && "createImageBitmap" in globalThis) {
    try {
      const blob = await new ImageCaptureApi(stream.getVideoTracks()[0]).takePhoto();
      bitmap = await createImageBitmap(blob);
      const scale = Math.min(1, 2000 / bitmap.width, 1600 / bitmap.height);
      source.width = Math.max(1, Math.round(bitmap.width * scale));
      source.height = Math.max(1, Math.round(bitmap.height * scale));
      source.getContext("2d", { willReadFrequently: true })?.drawImage(bitmap, 0, 0, source.width, source.height);
    } catch (error) {
      reportDiagnostic?.(`Captura em alta resolução: ${describeBarcodeError(error)}`);
      bitmap = null;
    }
  }

  if (!bitmap) {
    source.width = video.videoWidth;
    source.height = video.videoHeight;
    source.getContext("2d", { willReadFrequently: true })?.drawImage(video, 0, 0);
  }
  bitmap?.close();

  const makeVariant = (
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    filter = "none",
  ) => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sw));
    canvas.height = Math.max(1, Math.round(sh));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return canvas;
    context.filter = filter;
    context.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas;
  };

  const rotateVariant = (input: HTMLCanvasElement, clockwise: boolean) => {
    const canvas = document.createElement("canvas");
    canvas.width = input.height;
    canvas.height = input.width;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return canvas;
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(clockwise ? Math.PI / 2 : -Math.PI / 2);
    context.drawImage(input, -input.width / 2, -input.height / 2);
    return canvas;
  };

  const width = source.width;
  const height = source.height;
  const centerCrop = makeVariant(width * 0.05, height * 0.18, width * 0.9, height * 0.64);
  const contrasted = makeVariant(0, 0, width, height, "grayscale(100%) contrast(180%)");
  const contrastedCrop = makeVariant(width * 0.05, height * 0.18, width * 0.9, height * 0.64, "grayscale(100%) contrast(200%)");
  const candidates = [
    source,
    centerCrop,
    contrasted,
    contrastedCrop,
    rotateVariant(source, true),
    rotateVariant(source, false),
    rotateVariant(contrastedCrop, true),
    rotateVariant(contrastedCrop, false),
  ];

  for (const [index, candidate] of candidates.entries()) {
    try {
      const value = await decodeCanvasWithQuagga(candidate);
      if (value) return value;
      reportDiagnostic?.(`Quagga, variação ${index + 1}/${candidates.length}: nenhum código localizado.`);
    } catch (error) {
      reportDiagnostic?.(`Quagga, variação ${index + 1}/${candidates.length}: ${describeBarcodeError(error)}`);
    }
  }

  const NativeDetector = getNativeBarcodeDetector();
  if (NativeDetector) {
    try {
      const detector = new NativeDetector();
      for (const candidate of candidates) {
        const [detected] = await detector.detect(candidate);
        if (detected?.rawValue) return detected.rawValue.trim();
      }
    } catch (error) {
      reportDiagnostic?.(`Detector nativo: ${describeBarcodeError(error)}`);
      // Continue with ZXing when the browser detector cannot analyze the photo.
    }
  }

  const [{ BrowserMultiFormatOneDReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
    import("@zxing/browser"),
    import("@zxing/library"),
  ]);
  const formats = [BarcodeFormat.CODABAR, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.ITF, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E];
  const hints = new globalThis.Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, formats);
  const reader = new BrowserMultiFormatOneDReader(hints);
  for (const [index, candidate] of candidates.entries()) {
    try {
      return reader.decodeFromCanvas(candidate).getText().trim();
    } catch (error) {
      reportDiagnostic?.(`ZXing, variação ${index + 1}/${candidates.length}: ${describeBarcodeError(error)}`);
      // Try the next crop/contrast variation.
    }
  }
  return null;
};

const downloadXlsx = (filename: string, sheetName: string, rows: (string | number)[][]) => {
  const xml = (value: string | number) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const columnName = (index: number) => {
    let result = "";
    for (let current = index + 1; current > 0; current = Math.floor((current - 1) / 26)) result = String.fromCharCode(65 + ((current - 1) % 26)) + result;
    return result;
  };
  const widths = Array.from({ length: Math.max(1, ...rows.map((row) => row.length)) }, (_, column) =>
    Math.min(55, Math.max(12, ...rows.map((row) => String(row[column] ?? "").length + 2))),
  );
  const cells = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => {
    const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
    return typeof value === "number"
      ? `<c r="${reference}"${rowIndex === 0 ? ' s="1"' : ""}><v>${value}</v></c>`
      : `<c r="${reference}" t="inlineStr"${rowIndex === 0 ? ' s="1"' : ""}><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
  }).join("")}</row>`).join("");
  const lastColumn = columnName(widths.length - 1);
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("")}</cols><sheetData>${cells}</sheetData>${rows.length ? `<autoFilter ref="A1:${lastColumn}${rows.length}"/>` : ""}</worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`;
  const files = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName.slice(0, 31).replace(/[\\/:*?<>|]/g, "-"))}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(worksheet),
    "xl/styles.xml": strToU8(styles),
  };
  const blob = new Blob([zipSync(files, { level: 6 })], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeDownloadName(filename)}.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const statusClass = (status: string) => {
  if (/Disponível|Concluído|Devolvido/i.test(status)) return "green";
  if (/manutenção|Aguardando/i.test(status)) return "amber";
  if (/Danificado|Extraviado|Atrasado|Baixado/i.test(status)) return "red";
  if (/Emprestado/i.test(status)) return "purple";
  return "blue";
};

interface AlertItem {
  id: string;
  title: string;
  description: string;
  page: Page;
  tone: "red" | "navy" | "dark";
  icon: React.ReactNode;
}

const buildMaintenanceItems = (assets: Asset[]): Maintenance[] =>
  assets
    .filter((asset) => asset.status === "Em manutenção")
    .map((asset, index) => ({
      id: `imported-maintenance-${asset.id}`,
      assetId: asset.id,
      assetCode: asset.code,
      assetName: asset.name,
      issue:
        asset.notes && asset.notes !== "-"
          ? asset.notes
          : `Revisão técnica preventiva de ${asset.name.toLowerCase()}`,
      technician: index % 4 === 0 ? "Equipe de TI" : "A definir",
      status:
        index % 3 === 0
          ? "Aguardando manutenção"
          : index % 3 === 1
            ? "Em manutenção"
            : "Aguardando peça",
      openedAt: asset.updatedAt,
      cost: 0,
    }));

const buildChecklistTemplates = (assets: Asset[]): ChecklistTemplate[] =>
  [...new Set(assets.map((asset) => asset.room).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "pt-BR"))
    .map((location, index) => ({
      id: `checklist-${index + 1}`,
      name: `Checklist patrimonial — ${location}`,
      location,
      items: [
        "Conferir código de barras ou numeração",
        "Validar descrição e quantidade dos equipamentos",
        "Registrar estado de conservação",
        "Confirmar local e responsável",
        "Verificar cabos, acessórios e condições de segurança",
        "Registrar divergências, danos e observações",
      ],
    }));

const localIsoDate = (value: Date) => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const isBusinessDay = (value: Date) => value.getDay() !== 0 && value.getDay() !== 6;

const isBusinessDateValue = (value: string) => {
  const date = new Date(`${value}T12:00:00`);
  return !Number.isNaN(date.getTime()) && isBusinessDay(date);
};

const nextBusinessDate = (value: Date) => {
  const date = new Date(value.getFullYear(), value.getMonth(), value.getDate());
  while (!isBusinessDay(date)) date.setDate(date.getDate() + 1);
  return date;
};

const monthlyChecklistDate = (month: Date, templateIndex: number) => {
  const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const availableDates = Array.from({ length: Math.max(lastDay - 4, 1) }, (_, index) =>
    new Date(month.getFullYear(), month.getMonth(), index + 5),
  ).filter(isBusinessDay);
  return availableDates[templateIndex % availableDates.length];
};

const daysBetween = (from: Date, to: Date) => {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((end - start) / 86400000);
};

const isElectronicAsset = (asset: Asset) => {
  const category = asset.category.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/moveis|utensilios|jogos|diversao|suporte|mastro/.test(category)) return false;
  return /equipamento|informatica|eletron|telecom|audio|video|som|eletrodomestico/.test(category);
};

const canHandleTicket = (ticket: SupportTicket, user: SessionUser, assets: Asset[]) => {
  if (user.role !== "nti") return true;
  if (!ticket.audience.includes("NTI")) return false;
  if (!ticket.assetId) return ticket.category === "Falha de sistema" || ticket.category === "Dúvida";
  const asset = assets.find((item) => item.id === ticket.assetId);
  return Boolean(asset && isElectronicAsset(asset));
};

const canMaintainItem = (item: Maintenance, user: SessionUser, assets: Asset[]) => {
  if (user.role !== "nti") return true;
  const asset = assets.find((candidate) => candidate.id === item.assetId);
  return Boolean(asset && isElectronicAsset(asset));
};

function Logo({ light = false }: { light?: boolean }) {
  return (
    <div className={`logo ${light ? "light" : ""}`}>
      <span className="upe-logo-wrap">
        <img
          src="/upe-logo.png"
          alt="UPE — Universidade de Pernambuco, Campus Caruaru"
        />
      </span>
      <div className="system-name">
        <strong>Patrimônio</strong>
        <small>Gestão universitária</small>
      </div>
    </div>
  );
}

function Status({ children }: { children: string }) {
  return (
    <span className={`status ${statusClass(children)}`}>
      <i />
      {children}
    </span>
  );
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <div>
        <PackageCheck />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div
      className="modal-wrap"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <section className={`modal ${wide ? "wide" : ""}`}>
        <header>
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-btn" onClick={onClose}>
            <X />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  );
}

function BarcodeLabel({ code, compact = false }: { code: string; compact?: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!svgRef.current) return;
    JsBarcode(svgRef.current, code, {
      format: "CODE128",
      lineColor: "#101820",
      background: "#ffffff",
      displayValue: true,
      height: compact ? 48 : 82,
      width: compact ? 1.25 : 1.7,
      fontSize: compact ? 11 : 14,
      margin: compact ? 12 : 16,
    });
  }, [code, compact]);
  return (
    <div className={`barcode-label ${compact ? "compact" : ""}`} aria-label={`Código ${code}`}>
      <svg ref={svgRef} />
    </div>
  );
}

function PublicArea({
  assets,
  onLogin,
  onCreateTicket,
  now,
}: {
  assets: Asset[];
  onLogin: () => void;
  onCreateTicket: (ticket: SupportTicket) => void;
  now: Date;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Asset | null>(null);
  const [scan, setScan] = useState(false);
  const [chat, setChat] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const [supportAsset, setSupportAsset] = useState<Asset | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const publicAssets = useMemo(
    () => assets.filter((a) => a.visibility === "Público"),
    [assets],
  );
  const results =
    query.trim().length > 1
      ? publicAssets
          .filter((a) =>
            `${a.code} ${a.name} ${a.category} ${a.room}`
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .slice(0, 6)
      : [];

  return (
    <div className="public-page">
      <nav className="public-nav container">
        <Logo />
        <div className="public-links">
          <a href="#consulta">Consulta</a>
          <a href="#servicos">Serviços</a>
          <a href="#sobre">Sobre</a>
        </div>
        <button className="btn secondary" onClick={onLogin}>
          <LogIn /> Área do funcionário
        </button>
      </nav>
      <main>
        <section className="hero">
          <div className="hero-glow" />
          <div className="container hero-grid">
            <div className="hero-copy">
              <div className="eyebrow">
                <Sparkles /> Patrimônio público, simples e transparente
              </div>
              <h1>
                Encontre um patrimônio em <em>poucos segundos.</em>
              </h1>
              <p>
                Consulte equipamentos e espaços públicos da UPE Campus Caruaru
                com segurança — sem precisar de login.
              </p>
              <div className="public-search" id="consulta">
                <Search />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Digite o código, nome ou categoria"
                />
                <button>Consultar</button>
                {results.length > 0 && (
                  <div className="search-results">
                    {results.map((asset) => (
                      <button
                        key={asset.id}
                        onClick={() => {
                          setSelected(asset);
                          setQuery("");
                        }}
                      >
                        <span>
                          <strong>{asset.name}</strong>
                          <small>
                            {asset.code} • {asset.category}
                          </small>
                        </span>
                        <ChevronRight />
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <span className="helper">
                <ShieldCheck /> Somente informações autorizadas são exibidas.
              </span>
            </div>
            <div className="hero-card">
              <div className="scan-visual">
                <BarcodeLabel code="4407020009112022" compact />
                <div className="scan-line" />
              </div>
              <div>
                <span>Consulta rápida</span>
                <h3>Leia o código de barras</h3>
                <p>
                  Identifique equipamentos e consulte o status público na hora.
                </p>
              </div>
              <button className="btn full" onClick={() => setScan(true)}>
                <ScanLine /> Abrir scanner
              </button>
            </div>
          </div>
        </section>
        <section className="public-stats">
          <div className="container">
            <div>
              <strong>{fmt.format(assets.length)}</strong>
              <span>bens catalogados</span>
            </div>
            <div>
              <strong>{fmt.format(publicAssets.length)}</strong>
              <span>itens de consulta pública</span>
            </div>
            <div>
              <strong>100%</strong>
              <span>rastreabilidade digital</span>
            </div>
            <div>
              <strong>24h</strong>
              <span>consulta disponível</span>
            </div>
          </div>
        </section>
        <section className="public-services container" id="servicos">
          <div className="section-title">
            <span>Serviços digitais</span>
            <h2>Como podemos ajudar?</h2>
            <p>
              Acesse informações patrimoniais de forma direta, acessível e
              segura.
            </p>
          </div>
          <div className="service-grid">
            <button
              onClick={() =>
                document
                  .querySelector<HTMLInputElement>(".public-search input")
                  ?.focus()
              }
            >
              <div className="service-icon greenish">
                <Search />
              </div>
              <h3>Consultar patrimônio</h3>
              <p>Busque por identificação, nome ou categoria.</p>
              <span>
                Acessar consulta <ChevronRight />
              </span>
            </button>
            <button onClick={() => setScan(true)}>
              <div className="service-icon ochre">
                <Barcode />
              </div>
              <h3>Ler código de barras</h3>
              <p>Use a câmera ou digite a numeração da etiqueta.</p>
              <span>
                Abrir scanner <ChevronRight />
              </span>
            </button>
            <button onClick={() => {
              setSupportAsset(null);
              setSupportOpen(true);
            }}>
              <div className="service-icon purpleish">
                <MessageSquareWarning />
              </div>
              <h3>Informar dano ou pedir suporte</h3>
              <p>Envie uma mensagem ao Administrativo e ao NTI.</p>
              <span>
                Abrir chamado <ChevronRight />
              </span>
            </button>
          </div>
        </section>
        <section className="institution" id="sobre">
          <div className="container">
            <div>
              <span className="eyebrow">Gestão responsável</span>
              <h2>Tecnologia a serviço do patrimônio público.</h2>
              <p>
                A plataforma reúne o acervo da universidade em um ambiente
                confiável, melhora a localização dos bens e garante
                transparência com privacidade.
              </p>
            </div>
            <div className="quote-card">
              <ShieldCheck />
              <p>
                Dados administrativos, valores, documentos e informações
                pessoais permanecem protegidos e acessíveis apenas a usuários
                autorizados.
              </p>
            </div>
          </div>
        </section>
      </main>
      <footer>
        <div className="container">
          <Logo light />
          <p>Universidade de Pernambuco • Campus Caruaru</p>
          <div className="footer-credits">
            <span>© {now.getFullYear()} UPE</span>
            <span>Desenvolvido por <strong>Flomap</strong></span>
          </div>
        </div>
      </footer>
      {selected && (
        <PublicAsset
          asset={selected}
          onClose={() => setSelected(null)}
          onReport={() => {
            setSupportAsset(selected);
            setSelected(null);
            setSupportOpen(true);
          }}
        />
      )}
      {scan && (
        <Scanner
          assets={assets}
          onFound={(asset) => {
            setScan(false);
            if (asset.visibility === "Público") setSelected(asset);
            else {
              setSupportAsset(asset);
              setSupportOpen(true);
            }
          }}
          onClose={() => setScan(false)}
        />
      )}
      {chat && (
        <ChatPanel
          assets={publicAssets}
          publicMode
          onClose={() => setChat(false)}
        />
      )}
      {supportOpen && (
        <SupportForm
          asset={supportAsset}
          onClose={() => setSupportOpen(false)}
          onSubmit={(ticket) => {
            onCreateTicket(ticket);
            setSupportOpen(false);
            setConfirmation(`Chamado enviado. ${ticket.audience.join(" e ")} ${ticket.audience.length > 1 ? "foram notificados" : "foi notificado"}.`);
            setTimeout(() => setConfirmation(""), 4200);
          }}
        />
      )}
      {confirmation && <div className="toast"><Check /> {confirmation}</div>}
    </div>
  );
}

function PublicAsset({
  asset,
  onClose,
  onReport,
}: {
  asset: Asset;
  onClose: () => void;
  onReport: () => void;
}) {
  return (
    <Modal
      title="Consulta pública"
      subtitle="Informações autorizadas para visualização"
      onClose={onClose}
    >
      <div className="public-asset">
        <div className="asset-hero-icon">
          <Boxes />
        </div>
        <div>
          <span className="muted">{asset.category}</span>
          <h2>{asset.name}</h2>
          <code>{asset.code}</code>
        </div>
      </div>
      <div className="info-grid">
        <Info label="Status">
          <Status>{asset.status}</Status>
        </Info>
        <Info label="Localização">{asset.room}</Info>
        <Info label="Setor">{asset.sector}</Info>
        <Info label="Campus">{asset.campus}</Info>
      </div>
        <div className="qr-strip barcode-strip">
          <BarcodeLabel code={asset.code} compact />
          <div>
            <strong>Identificação verificada</strong>
            <p>Numeração proveniente da coluna Nº Série.</p>
          </div>
        </div>
      <button className="btn primary full report-problem" onClick={onReport}>
        <MessageSquareWarning /> Informar dano neste equipamento
      </button>
      <div className="privacy-note">
        <ShieldCheck />
        <span>
          <strong>Consulta segura</strong>Informações administrativas e pessoais
          não são exibidas.
        </span>
      </div>
    </Modal>
  );
}

function Scanner({
  assets,
  onFound,
  onClose,
}: {
  assets: Asset[];
  onFound: (asset: Asset) => void;
  onClose: () => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [cameraStatus, setCameraStatus] = useState("Solicitando acesso à câmera...");
  const [cameraFailed, setCameraFailed] = useState(false);
  const [cameraAttempt, setCameraAttempt] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [scannerDiagnostic, setScannerDiagnostic] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const assetsRef = useRef(assets);
  const onFoundRef = useRef(onFound);
  assetsRef.current = assets;
  onFoundRef.current = onFound;
  useEffect(() => {
    let controls: IScannerControls | null = null;
    let stream: MediaStream | null = null;
    let nativeTimer: number | undefined;
    let quaggaTimer: number | undefined;
    let quaggaBusy = false;
    let stopped = false;
    let lastValue = "";
    let attempts = 0;
    let lastDiagnosticAt = 0;
    const handleRead = (value: string, activeControls?: IScannerControls) => {
      if (stopped) return;
      const normalized = normalizeBarcode(value);
      if (!normalized || normalized === lastValue) return;
      lastValue = normalized;
      setCode(value);
      const found = findAssetByBarcode(assetsRef.current, value);
      if (found) {
        setError("");
        setCameraStatus(`Código ${value} identificado.`);
        stopped = true;
        activeControls?.stop();
        controls?.stop();
        stream?.getTracks().forEach((track) => track.stop());
        onFoundRef.current(found);
      } else {
        setError(`Código ${value} lido, mas não encontrado na coluna Nº Série.`);
        window.setTimeout(() => { lastValue = ""; }, 1200);
      }
    };
    const start = async () => {
      try {
        if (!videoRef.current) return;
        setCameraFailed(false);
        setCameraStatus("Solicitando acesso à câmera...");
        const [{ BrowserMultiFormatOneDReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
          import("@zxing/browser"),
          import("@zxing/library"),
        ]);
        if (stopped || !videoRef.current) return;
        const formats = [BarcodeFormat.CODABAR, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.ITF, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E];
        const hints = new globalThis.Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, formats);
        const reader = new BrowserMultiFormatOneDReader(hints, { delayBetweenScanAttempts: 140, delayBetweenScanSuccess: 600, tryPlayVideoTimeout: 5000 });
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Este navegador não oferece acesso à câmera.");
        const video = videoRef.current;
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        if (stopped) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        await video.play();
        if (stopped) return;
        setCameraStatus("Câmera ligada — posicione o código dentro da área marcada.");
        controls = reader.scan(
          video,
          (result, scanError, activeControls) => {
            if (stopped) return;
            if (result) {
              setScannerDiagnostic(`Leitura concluída após ${attempts + 1} quadros analisados.`);
              handleRead(result.getText().trim(), activeControls);
              return;
            }
            if (scanError) {
              attempts += 1;
              const detail = describeBarcodeError(scanError);
              const currentTime = Date.now();
              if (currentTime - lastDiagnosticAt >= 1000) {
                lastDiagnosticAt = currentTime;
                setScannerDiagnostic(`${attempts} quadros analisados — ${detail}.`);
              }
              if (attempts === 1 || !/nenhum padrão/i.test(detail)) {
                console.info(`[Leitor de código] tentativa ${attempts}: ${detail}`, scanError);
              }
            }
          },
        );
        const NativeDetector = getNativeBarcodeDetector();
        if (NativeDetector) {
          try {
            const detector = new NativeDetector();
            const detectWithBrowser = async () => {
              if (stopped) return;
              try {
                const [detected] = await detector.detect(video);
                if (detected?.rawValue) handleRead(detected.rawValue.trim());
              } catch {
                // ZXing remains active when the native detector rejects a frame.
              }
              if (!stopped) nativeTimer = window.setTimeout(detectWithBrowser, 180);
            };
            void detectWithBrowser();
          } catch {
            // The native API is optional; ZXing is the primary decoder.
          }
        }
        const detectWithQuagga = async () => {
          if (stopped || quaggaBusy) return;
          quaggaBusy = true;
          try {
            const value = await decodeVideoFrameWithQuagga(video);
            if (!stopped && value) {
              setScannerDiagnostic("Quagga2 identificou o código no quadro atual.");
              handleRead(value);
            }
          } catch (error) {
            if (!stopped) setScannerDiagnostic(`Quagga2: ${describeBarcodeError(error)}.`);
          } finally {
            quaggaBusy = false;
            if (!stopped) quaggaTimer = window.setTimeout(detectWithQuagga, 700);
          }
        };
        void detectWithQuagga();
      } catch (caught) {
        if (stopped) return;
        const name = caught instanceof DOMException ? caught.name : "";
        const message = name === "NotAllowedError"
          ? "Permissão da câmera negada. Autorize-a nas configurações do navegador."
          : name === "NotFoundError"
            ? "Nenhuma câmera foi encontrada neste dispositivo."
            : name === "NotReadableError"
              ? "A câmera está sendo usada por outro aplicativo ou aba."
              : name === "SecurityError"
                ? "A câmera exige acesso por HTTPS ou localhost."
                : caught instanceof Error
                  ? `Não foi possível ligar a câmera: ${caught.message}`
                  : "Câmera indisponível — digite a numeração abaixo.";
        setCameraStatus(message);
        setCameraFailed(true);
        setScannerDiagnostic(`Falha ao iniciar: ${describeBarcodeError(caught)}.`);
      }
    };
    start();
    return () => {
      stopped = true;
      if (nativeTimer !== undefined) window.clearTimeout(nativeTimer);
      if (quaggaTimer !== undefined) window.clearTimeout(quaggaTimer);
      controls?.stop();
      stream?.getTracks().forEach((track) => track.stop());
      if (videoRef.current?.srcObject === stream) videoRef.current.srcObject = null;
    };
  }, [cameraAttempt]);
  const capturePhoto = async () => {
    if (!videoRef.current || capturing) return;
    setCapturing(true);
    setError("");
    setCameraStatus("Capturando e analisando a foto...");
    try {
      const value = await captureBarcodePhoto(videoRef.current, (detail) => {
        setScannerDiagnostic(detail);
        console.info(`[Leitor de código/foto] ${detail}`);
      });
      if (!value) {
        setError("Nenhum código foi localizado na foto. Aproxime a etiqueta, evite reflexos e tente novamente.");
        setCameraStatus("Foto analisada — reposicione a etiqueta para uma nova captura.");
        return;
      }
      setCode(value);
      const found = findAssetByBarcode(assetsRef.current, value);
      if (found) onFoundRef.current(found);
      else {
        setError(`Código ${value} lido, mas não encontrado na coluna Nº Série.`);
        setCameraStatus(`Código ${value} identificado na foto.`);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível analisar a foto.");
      setCameraStatus("Não foi possível capturar a foto.");
    } finally {
      setCapturing(false);
    }
  };
  const readSavedPhoto = async (file: File) => {
    if (capturing) return;
    setCapturing(true);
    setError("");
    setCameraStatus(`Analisando ${file.name}...`);
    setScannerDiagnostic("Quagga2 está analisando o arquivo original, sem passar pela câmera.");
    try {
      const value = await decodeFileWithQuagga(file);
      if (!value) {
        setError("Nenhum código foi localizado no arquivo selecionado.");
        setCameraStatus("Arquivo analisado sem resultado.");
        setScannerDiagnostic("Quagga2 concluiu a análise do arquivo, mas não encontrou um código válido.");
        return;
      }
      setCode(value);
      setScannerDiagnostic(`Quagga2 decodificou o arquivo como ${value}.`);
      const found = findAssetByBarcode(assetsRef.current, value);
      if (found) onFoundRef.current(found);
      else {
        setError(`Código ${value} lido, mas não encontrado na coluna Nº Série.`);
        setCameraStatus(`Código ${value} identificado no arquivo.`);
      }
    } catch (caught) {
      const detail = describeBarcodeError(caught);
      setError(`Não foi possível analisar o arquivo: ${detail}.`);
      setScannerDiagnostic(`Quagga2: ${detail}.`);
      console.error("[Leitor de código/arquivo]", caught);
    } finally {
      setCapturing(false);
    }
  };
  const search = () => {
    const found = findAssetByBarcode(assets, code);
    if (found) onFound(found);
    else setError("Numeração não encontrada na coluna Nº Série.");
  };
  return (
    <Modal
      title="Leitura de código de barras"
      subtitle="Leia a etiqueta ou digite a numeração"
      onClose={onClose}
    >
      <div className="camera">
        <video ref={videoRef} muted playsInline autoPlay />
        <div className="corners" />
        <span>{cameraStatus}</span>
      </div>
      <button className="btn primary full camera-capture" onClick={capturePhoto} disabled={capturing || cameraFailed}>
        <ScanLine /> {capturing ? "Analisando foto..." : "Capturar e analisar foto"}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const input = event.currentTarget;
          const file = input.files?.[0];
          if (file) void readSavedPhoto(file).finally(() => { input.value = ""; });
        }}
      />
      <button className="btn secondary full saved-photo" onClick={() => fileInputRef.current?.click()} disabled={capturing}>
        <Barcode /> Selecionar foto salva
      </button>
      {scannerDiagnostic && <div className="scanner-diagnostic"><strong>Diagnóstico</strong><span>{scannerDiagnostic}</span></div>}
      {cameraFailed && <button className="btn secondary full camera-retry" onClick={() => setCameraAttempt((attempt) => attempt + 1)}><RotateCcw /> Tentar ligar a câmera novamente</button>}
      <label className="field">
        <span>Código lido ou digitado</span>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={assets[0]?.code || "PAT-00001"}
        />
      </label>
      {error && <div className="form-error"><AlertTriangle /> {error}</div>}
      <button className="btn primary full" onClick={search}>
        <Barcode /> Identificar patrimônio
      </button>
    </Modal>
  );
}

function SupportForm({
  asset,
  onClose,
  onSubmit,
  requesterName = "",
  requesterContact = "",
}: {
  asset: Asset | null;
  onClose: () => void;
  onSubmit: (ticket: SupportTicket) => void;
  requesterName?: string;
  requesterContact?: string;
}) {
  const [requester, setRequester] = useState(requesterName);
  const [contact, setContact] = useState(requesterContact);
  const [location, setLocation] = useState(asset?.room || "");
  const [category, setCategory] = useState<SupportTicket["category"]>(asset ? "Equipamento danificado" : "Falha de sistema");
  const [description, setDescription] = useState("");
  const audience: SupportTicket["audience"] = asset && !isElectronicAsset(asset) ? ["Administrativo"] : ["Administrativo", "NTI"];
  const save = () => onSubmit({
    id: `ticket-${Date.now()}`,
    assetId: asset?.id,
    assetCode: asset?.code,
    assetName: asset?.name,
    requester,
    contact,
    location,
    category,
    description,
    audience,
    status: "Novo",
    createdAt: new Date().toISOString(),
  });
  return (
    <Modal title="Enviar mensagem de suporte" subtitle={audience.includes("NTI") ? "O Administrativo e o NTI serão notificados" : "O Administrativo será notificado"} onClose={onClose}>
      {asset && (
        <div className="linked-asset">
          <Barcode />
          <span><strong>{asset.name}</strong><small>{asset.code} • {asset.room}</small></span>
        </div>
      )}
      <div className="form-grid">
        <Field label="Seu nome"><input value={requester} onChange={(e) => setRequester(e.target.value)} /></Field>
        <Field label="E-mail ou telefone"><input value={contact} onChange={(e) => setContact(e.target.value)} /></Field>
        <Field label="Local"><input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Bloco, sala ou setor" /></Field>
        <Field label="Tipo de solicitação">
          <select value={category} onChange={(e) => setCategory(e.target.value as SupportTicket["category"])}>
            <option>Equipamento danificado</option><option>Falha de sistema</option><option>Dúvida</option><option>Outro</option>
          </select>
        </Field>
      </div>
      <Field label="Mensagem"><textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Descreva o defeito ou a ajuda necessária..." /></Field>
      <button className="btn primary full" disabled={!requester || !description || !location} onClick={save}>
        <Send /> Enviar chamado
      </button>
    </Modal>
  );
}

function CreateTicketPage({
  user,
  onCreated,
  onNotify,
}: {
  user: SessionUser;
  onCreated: (ticket: SupportTicket) => void;
  onNotify: (message: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const submit = async (ticket: SupportTicket) => {
    let saved = ticket;
    if (hasApi()) {
      try {
        saved = await api<SupportTicket>("/public/tickets", { method: "POST", body: JSON.stringify(ticket) });
      } catch (cause) {
        onNotify(cause instanceof Error ? cause.message : "Falha ao criar chamado.");
        return;
      }
    }
    onCreated(saved);
    setOpen(false);
    onNotify("Chamado criado com sucesso.");
  };
  return (
    <>
      <div className="page-actions">
        <div><h2>Criar chamado</h2><p>Informe um problema ou solicite atendimento às equipes responsáveis.</p></div>
        <button className="btn primary" onClick={() => setOpen(true)}><Plus /> Novo chamado</button>
      </div>
      <section className="panel empty"><MessageSquareWarning /><h3>Canal de atendimento</h3><p>Use o formulário para registrar danos, falhas de sistema ou dúvidas.</p><button className="btn primary" onClick={() => setOpen(true)}>Abrir formulário</button></section>
      {open && <SupportForm asset={null} requesterName={user.name} requesterContact={user.email} onClose={() => setOpen(false)} onSubmit={(ticket) => void submit(ticket)} />}
    </>
  );
}

function Login({
  onSuccess,
  onBack,
}: {
  onSuccess: (user: SessionUser) => void;
  onBack: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      if (hasApi()) onSuccess(sessionFromApi(await apiLogin(email, password)));
      else setError("Configure VITE_API_URL no arquivo .env para autenticar pelo servidor.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível entrar.");
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="login-page">
      <div className="login-brand">
        <button className="back-link" onClick={onBack}>
          <ArrowLeftRight /> Voltar ao portal
        </button>
        <div className="login-message">
          <Logo light />
          <span className="eyebrow">
            <ShieldCheck /> Ambiente institucional seguro
          </span>
          <h1>Gestão patrimonial em uma visão completa.</h1>
          <p>
            Controle inventários, movimentações, empréstimos e manutenções com
            rastreabilidade.
          </p>
          <div className="login-points">
            <span>
              <Check /> Dados centralizados
            </span>
            <span>
              <Check /> Histórico imutável
            </span>
            <span>
              <Check /> Atualizações instantâneas
            </span>
          </div>
        </div>
      </div>
      <div className="login-form-wrap">
        <form className="login-form" onSubmit={submit}>
          <span className="mobile-logo">
            <Logo />
          </span>
          <h2>Boas-vindas</h2>
          <p>Entre com sua conta institucional para continuar.</p>
          <label className="field">
            <span>E-mail institucional</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Senha</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && (
            <div className="form-error">
              <AlertTriangle />
              {error}
            </div>
          )}
          <button className="btn primary full" type="submit" disabled={submitting || !email || !password}>
            {submitting ? "Entrando..." : "Entrar na plataforma"} <ChevronRight />
          </button>
          <small className="login-help">
            <CircleHelp /> Precisa de ajuda? Fale com o suporte de TI.
          </small>
        </form>
      </div>
    </div>
  );
}

function Sidebar({
  page,
  setPage,
  open,
  setOpen,
  logout,
  maintenanceCount,
  ticketCount,
  user,
}: {
  page: Page;
  setPage: (p: Page) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
  logout: () => void;
  maintenanceCount: number;
  ticketCount: number;
  user: SessionUser;
}) {
  const allMain: [Page, string, React.ReactNode][] = [
    ["dashboard", "Visão geral", <Gauge />],
    ["assets", "Patrimônios", <Boxes />],
    ["map", "Mapa patrimonial", <Map />],
    ["inventory", "Inventário", <ClipboardCheck />],
    ["inspections", "Vistorias", <ListChecks />],
    ["create-ticket", "Criar chamado", <MessageSquareWarning />],
    ["tickets", "Chamados", <MessageSquareWarning />],
    ["movements", "Movimentações", <ArrowLeftRight />],
    ["loans", "Empréstimos", <PackageCheck />],
    ["maintenance", "Manutenção", <Wrench />],
    ["reports", "Relatórios", <FileBarChart />],
    ["chat", "Assistente IA", <Bot />],
  ];
  const allowed: Record<UserRole, Page[]> = {
    admin: allMain.map(([key]) => key),
    administration: allMain.map(([key]) => key),
    nti: ["assets", "inventory", "tickets"],
    student: ["assets", "inspections", "create-ticket"],
  };
  const main = allMain.filter(([key]) => allowed[user.role].includes(key));
  const admin: [Page, string, React.ReactNode][] = [
    ["users", "Usuários", <Users />],
    ["settings", "Configurações", <Settings />],
  ];
  const item = ([key, label, icon]: [Page, string, React.ReactNode]) => (
    <button
      key={key}
      className={page === key ? "active" : ""}
      onClick={() => {
        setPage(key);
        setOpen(false);
      }}
    >
      {icon}
      <span>{label}</span>
      {key === "maintenance" && maintenanceCount > 0 && <b>{maintenanceCount}</b>}
      {key === "tickets" && ticketCount > 0 && <b>{ticketCount}</b>}
    </button>
  );
  return (
    <>
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <div className="side-head">
          <Logo light />
          <button className="side-close" onClick={() => setOpen(false)}>
            <X />
          </button>
        </div>
        <nav>
          <small>GESTÃO</small>
          {main.map(item)}
          <small>ADMINISTRAÇÃO</small>
          {user.role === "admin" && admin.map(item)}
        </nav>
        <div className="side-user">
          <div className="avatar">{user.initials}</div>
          <div>
            <strong>{user.name}</strong>
            <span>{user.label}</span>
          </div>
          <button onClick={logout}>
            <LogOut />
          </button>
        </div>
      </aside>
      {open && <div className="side-overlay" onClick={() => setOpen(false)} />}
    </>
  );
}

function Topbar({
  title,
  onMenu,
  onSearch,
  assets,
  maintenances,
  loans,
  onNavigate,
  tickets,
  user,
  inspections,
  checklistTemplates,
  now,
}: {
  title: string;
  onMenu: () => void;
  onSearch: (q: string) => void;
  assets: Asset[];
  maintenances: Maintenance[];
  loans: Loan[];
  onNavigate: (page: Page) => void;
  tickets: SupportTicket[];
  user: SessionUser;
  inspections: Inspection[];
  checklistTemplates: ChecklistTemplate[];
  now: Date;
}) {
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState(false);
  const activeMaintenance = maintenances.filter((item) => canMaintainItem(item, user, assets)).filter(
    (item) => item.status !== "Concluído",
  ).length;
  const damaged = assets.filter(
    (asset) => asset.status === "Danificado" || asset.status === "Extraviado",
  ).length;
  const overdue = loans.filter(
    (loan) =>
      loan.status === "Atrasado" ||
      (loan.status === "Emprestado" &&
        loan.dueDate &&
        new Date(`${loan.dueDate}T23:59:59`) < now),
  ).length;
  const today = now;
  const monthlyInspectionEvents = checklistTemplates.map((template, index) => {
    const dueDate = monthlyChecklistDate(today, index);
    const completed = inspections.some((inspection) =>
      inspection.templateId === template.id &&
      inspection.scheduledDate === localIsoDate(dueDate) &&
      inspection.status === "Concluída",
    );
    return { dueDate, completed };
  });
  const dueToday = monthlyInspectionEvents.filter((event) => !event.completed && daysBetween(today, event.dueDate) === 0).length;
  const dueSoon = monthlyInspectionEvents.filter((event) => {
    const remaining = daysBetween(today, event.dueDate);
    return !event.completed && remaining > 0 && remaining <= 5;
  }).length;
  const actionableTickets = tickets.filter((ticket) => canHandleTicket(ticket, user, assets));
  const permittedAlerts: Record<UserRole, Page[]> = {
    admin: ["tickets", "maintenance", "assets", "loans", "inventory", "inspections"],
    administration: ["tickets", "maintenance", "assets", "loans", "inventory", "inspections"],
    nti: ["tickets", "inventory", "assets"],
    student: ["assets", "inspections"],
  };
  const alerts = ([
    dueToday > 0 && {
      id: "inspections-today",
      title: `${dueToday} checklist${dueToday > 1 ? "s" : ""} para realizar hoje`,
      description: "Abra a vistoria e marque cada item conferido.",
      page: "inspections",
      tone: "red",
      icon: <CalendarDays />,
    },
    dueSoon > 0 && {
      id: "inspections-soon",
      title: `${dueSoon} checklist${dueSoon > 1 ? "s" : ""} nos próximos 5 dias`,
      description: "Vistorias mensais próximas da data programada.",
      page: "inspections",
      tone: "navy",
      icon: <ClipboardCheck />,
    },
    actionableTickets.filter((ticket) => ticket.status !== "Resolvido").length > 0 && {
      id: "tickets",
      title: `${actionableTickets.filter((ticket) => ticket.status !== "Resolvido").length} chamados aguardando atendimento`,
      description: "Mensagens enviadas pelo portal público.",
      page: "tickets",
      tone: "red",
      icon: <MessageSquareWarning />,
    },
    activeMaintenance > 0 && {
      id: "maintenance",
      title: `${activeMaintenance} manutenções em andamento`,
      description: "Acompanhe os chamados e prazos técnicos.",
      page: "maintenance",
      tone: "red",
      icon: <Wrench />,
    },
    damaged > 0 && {
      id: "damaged",
      title: `${damaged} patrimônios exigem atenção`,
      description: "Itens danificados ou extraviados no acervo.",
      page: "assets",
      tone: "dark",
      icon: <AlertTriangle />,
    },
    overdue > 0 && {
      id: "overdue",
      title: `${overdue} empréstimos atrasados`,
      description: "Existem devoluções com prazo vencido.",
      page: "loans",
      tone: "red",
      icon: <Clock3 />,
    },
    {
      id: "inventory",
      title: "Inventário do Bloco B em andamento",
      description: "A conferência atual está 68% concluída.",
      page: "inventory",
      tone: "navy",
      icon: <ClipboardCheck />,
    },
  ].filter(Boolean) as AlertItem[]).filter((alert) => permittedAlerts[user.role].includes(alert.page));
  const unread = read ? 0 : alerts.length;
  const navigate = (page: Page) => {
    onNavigate(page);
    setOpen(false);
    setRead(true);
  };
  return (
    <header className="topbar">
      <div className="page-heading">
        <button className="menu-btn" onClick={onMenu}>
          <Menu />
        </button>
        <div>
          <span>UPE / Gestão patrimonial</span>
          <h1>{title}</h1>
        </div>
      </div>
      <div className="top-actions">
        <div className="live-date" title="Data e hora sincronizadas com este dispositivo">
          <Clock3 />
          <span>{new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(now)}</span>
          <i />
        </div>
        <label className="global-search">
          <Search />
          <input
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Buscar patrimônio..."
          />
        </label>
        <div className="notification-wrap">
          <button
            className={`notification ${open ? "active" : ""}`}
            aria-label="Abrir central de alertas"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <Bell />
            {unread > 0 && <i>{unread > 9 ? "9+" : unread}</i>}
          </button>
          {open && (
            <div className="notification-panel">
              <header>
                <div>
                  <strong>Alertas</strong>
                  <span>{alerts.length} notificações importantes</span>
                </div>
                <button onClick={() => setRead(true)}>Marcar como lidas</button>
              </header>
              <div className="notification-list">
                {alerts.map((alert) => (
                  <button key={alert.id} onClick={() => navigate(alert.page)}>
                    <span className={`notification-icon ${alert.tone}`}>
                      {alert.icon}
                    </span>
                    <span>
                      <strong>{alert.title}</strong>
                      <small>{alert.description}</small>
                    </span>
                    <ChevronRight />
                  </button>
                ))}
              </div>
              <footer>
                <ShieldCheck />
                <span>
                  Alertas calculados a partir da base patrimonial atual.
                </span>
              </footer>
            </div>
          )}
        </div>
        <div className="avatar" title={`${user.name} — ${user.label}`}>
          {user.initials}
        </div>
      </div>
    </header>
  );
}

function Kpi({
  label,
  value,
  icon,
  tone,
  detail,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  tone: string;
  detail: string;
}) {
  return (
    <article className="kpi">
      <div className={`kpi-icon ${tone}`}>{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  );
}

function Dashboard({
  assets,
  movements,
  go,
  now,
}: {
  assets: Asset[];
  movements: Movement[];
  go: (p: Page) => void;
  now: Date;
}) {
  const count = (s: AssetStatus) => assets.filter((a) => a.status === s).length;
  const categories = useMemo(
    () =>
      Object.entries(
        assets.reduce<Record<string, number>>((acc, a) => {
          acc[a.category] = (acc[a.category] || 0) + 1;
          return acc;
        }, {}),
      )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5),
    [assets],
  );
  const max = Math.max(...categories.map(([, v]) => v), 1);
  const recent = movements.length
    ? movements.slice(0, 4)
    : assets
        .slice(0, 4)
        .map((a, i) => ({
          id: a.id,
          assetName: a.name,
          assetCode: a.code,
          from: a.room,
          to: a.sector,
          user: "Importação inicial",
          createdAt: a.updatedAt,
          reason: i ? "Cadastro atualizado" : "Base de dados importada",
        }));
  const totalValue = assets.reduce((sum, a) => sum + a.value, 0);
  return (
    <>
      <div className="welcome">
        <div>
          <span>{new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }).format(now)}</span>
          <h2>Olá, Dirceu. Aqui está o panorama de hoje.</h2>
        </div>
        <button className="btn primary" onClick={() => go("assets")}>
          <Plus /> Novo patrimônio
        </button>
      </div>
      <div className="kpi-grid">
        <Kpi
          label="Total de patrimônios"
          value={fmt.format(assets.length)}
          icon={<Boxes />}
          tone="forest"
          detail={`${currency.format(totalValue)} em bens`}
        />
        <Kpi
          label="Em uso"
          value={fmt.format(count("Em uso"))}
          icon={<PackageCheck />}
          tone="blue"
          detail={`${Math.round((count("Em uso") / Math.max(assets.length, 1)) * 100)}% do acervo`}
        />
        <Kpi
          label="Disponíveis"
          value={fmt.format(count("Disponível"))}
          icon={<Check />}
          tone="teal"
          detail="Prontos para alocação"
        />
        <Kpi
          label="Atenção necessária"
          value={fmt.format(count("Em manutenção") + count("Danificado"))}
          icon={<AlertTriangle />}
          tone="orange"
          detail="Manutenção ou dano"
        />
      </div>
      <div className="dashboard-grid">
        <section className="panel chart-panel">
          <PanelHead
            title="Patrimônios por categoria"
            subtitle="Distribuição dos itens cadastrados"
            action="Ver todos"
            onAction={() => go("assets")}
          />
          <div className="bars">
            {categories.map(([name, value], i) => (
              <div className="bar-row" key={name}>
                <span title={name}>{name}</span>
                <div>
                  <i
                    style={{
                      width: `${(value / max) * 100}%`,
                      background: [
                        "#263f6a",
                        "#ef3340",
                        "#536b93",
                        "#101820",
                        "#8797b3",
                      ][i],
                    }}
                  />
                </div>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
        </section>
        <section className="panel status-panel">
          <PanelHead
            title="Status do acervo"
            subtitle="Situação operacional atual"
          />
          <div className="donut-wrap">
            <div
              className="donut"
              style={{
                background: `conic-gradient(#263f6a 0 ${(count("Em uso") / assets.length) * 100}%, #ef3340 0 ${((count("Em uso") + count("Em manutenção")) / assets.length) * 100}%, #8797b3 0 ${((count("Em uso") + count("Em manutenção") + count("Disponível")) / assets.length) * 100}%, #ddd 0)`,
              }}
            >
              <span>
                <strong>{fmt.format(assets.length)}</strong>
                <small>itens</small>
              </span>
            </div>
            <div className="legend">
              <span>
                <i className="dot forest" />
                Em uso <strong>{count("Em uso")}</strong>
              </span>
              <span>
                <i className="dot ochre" />
                Manutenção <strong>{count("Em manutenção")}</strong>
              </span>
              <span>
                <i className="dot blue" />
                Disponíveis <strong>{count("Disponível")}</strong>
              </span>
              <span>
                <i className="dot gray" />
                Outros{" "}
                <strong>
                  {assets.length -
                    count("Em uso") -
                    count("Em manutenção") -
                    count("Disponível")}
                </strong>
              </span>
            </div>
          </div>
        </section>
        <section className="panel activity-panel">
          <PanelHead
            title="Atividades recentes"
            subtitle="Últimas alterações no patrimônio"
            action="Ver histórico"
            onAction={() => go("movements")}
          />
          <div className="activity-list">
            {recent.map((m, i) => (
              <div className="activity" key={m.id}>
                <div className={`activity-icon a${i}`}>
                  <History />
                </div>
                <div>
                  <strong>{m.assetName}</strong>
                  <p>
                    {m.reason}: <b>{m.from}</b>
                    {m.to && (
                      <>
                        {" "}
                        para <b>{m.to}</b>
                      </>
                    )}
                  </p>
                  <span>
                    {date(m.createdAt)} • {m.user}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="panel alerts">
          <PanelHead
            title="Alertas e pendências"
            subtitle="Itens que precisam de ação"
          />
          <button onClick={() => go("maintenance")}>
            <div className="alert-icon amber">
              <Wrench />
            </div>
            <span>
              <strong>{count("Em manutenção")} itens em manutenção</strong>
              <small>Acompanhar prazos e responsáveis</small>
            </span>
            <ChevronRight />
          </button>
          <button onClick={() => go("loans")}>
            <div className="alert-icon red">
              <Clock3 />
            </div>
            <span>
              <strong>
                {Math.max(2, Math.round(assets.length * 0.008))} empréstimos
                vencidos
              </strong>
              <small>Devolução pendente</small>
            </span>
            <ChevronRight />
          </button>
          <button onClick={() => go("inventory")}>
            <div className="alert-icon blue">
              <ClipboardCheck />
            </div>
            <span>
              <strong>Inventário do Bloco B</strong>
              <small>Conclusão prevista para {new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit" }).format(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3))}</small>
            </span>
            <ChevronRight />
          </button>
        </section>
      </div>
    </>
  );
}

function PanelHead({
  title,
  subtitle,
  action,
  onAction,
}: {
  title: string;
  subtitle?: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="panel-head">
      <div>
        <h3>{title}</h3>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action && (
        <button onClick={onAction}>
          {action}
          <ChevronRight />
        </button>
      )}
    </div>
  );
}
function Info({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="info">
      <span>{label}</span>
      <div>{children}</div>
    </div>
  );
}

function AssetsPage({
  assets,
  setAssets,
  initialQuery,
  onTransfer,
  canManage,
}: {
  assets: Asset[];
  setAssets: (a: Asset[]) => void;
  initialQuery: string;
  onTransfer: (a: Asset) => void;
  canManage: boolean;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [status, setStatus] = useState("Todos");
  const [category, setCategory] = useState("Todas");
  const [selected, setSelected] = useState<Asset | null>(null);
  const [editing, setEditing] = useState<Asset | "new" | null>(null);
  useEffect(() => setQuery(initialQuery), [initialQuery]);
  const categories = [...new Set(assets.map((a) => a.category))].sort();
  const filtered = assets
    .filter(
      (a) =>
        (status === "Todos" || a.status === status) &&
        (category === "Todas" || a.category === category) &&
        `${a.code} ${a.name} ${a.category} ${a.model} ${a.room} ${a.responsible}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .slice(0, 100);
  const save = async (asset: Asset) => {
    let saved = asset;
    if (hasApi()) {
      try { saved = await api<Asset>(editing === "new" ? "/assets" : `/assets/${asset.id}`, { method: editing === "new" ? "POST" : "PATCH", body: JSON.stringify(asset) }); }
      catch (cause) { alert(cause instanceof Error ? cause.message : "Falha ao salvar patrimônio."); return; }
    }
    setAssets(
      editing === "new"
        ? [saved, ...assets]
        : assets.map((a) => (a.id === saved.id ? saved : a)),
    );
    setEditing(null);
    setSelected(saved);
  };
  return (
    <>
      <div className="page-actions">
        <div>
          <h2>Patrimônios</h2>
          <p>Consulte e gerencie os bens do Campus Caruaru.</p>
        </div>
        {canManage && <button className="btn primary" onClick={() => setEditing("new")}>
          <Plus /> Cadastrar patrimônio
        </button>}
      </div>
      <section className="panel table-panel">
        <div className="table-tools">
          <label className="table-search">
            <Search />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Código, nome, modelo ou local..."
            />
          </label>
          <label>
            <Filter />
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option>Todas</option>
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            <Layers3 />
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option>Todos</option>
              {[
                "Em uso",
                "Disponível",
                "Emprestado",
                "Em manutenção",
                "Danificado",
                "Extraviado",
                "Baixado",
              ].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Patrimônio</th>
                <th>Categoria</th>
                <th>Localização</th>
                <th>Responsável</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => (
                <tr key={a.id}>
                  <td>
                    <button
                      className="asset-cell"
                      onClick={() => setSelected(a)}
                    >
                      <div>{a.name.slice(0, 1)}</div>
                      <span>
                        <strong>{a.name}</strong>
                        <small>
                          {a.code} • {a.model}
                        </small>
                      </span>
                    </button>
                  </td>
                  <td>{a.category}</td>
                  <td>
                    <strong>{a.room}</strong>
                    <small>
                      {a.sector} • {a.building}
                    </small>
                  </td>
                  <td>{a.responsible}</td>
                  <td>
                    <Status>{a.status}</Status>
                  </td>
                  <td>
                    <button className="icon-btn" onClick={() => setSelected(a)}>
                      <Eye />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="table-foot">
          <span>
            Exibindo {filtered.length} de {assets.length} patrimônios
          </span>
          <span>Os primeiros 100 resultados são mostrados.</span>
        </div>
      </section>
      {selected && (
        <AssetDetail
          asset={selected}
          onClose={() => setSelected(null)}
          onEdit={() => setEditing(selected)}
          onTransfer={() => onTransfer(selected)}
          canManage={canManage}
        />
      )}{" "}
      {editing && (
        <AssetForm
          asset={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
    </>
  );
}

function AssetForm({
  asset,
  onClose,
  onSave,
}: {
  asset: Asset | null;
  onClose: () => void;
  onSave: (a: Asset) => void;
}) {
  const blank: Asset = {
    id: `asset-${Date.now()}`,
    code: `PAT-${String(Date.now()).slice(-5)}`,
    name: "",
    description: "",
    category: "Equipamentos",
    brand: "",
    model: "",
    serial: "",
    responsible: "Não atribuído",
    sector: "Administração",
    room: "A definir",
    building: "Bloco A",
    campus: "Campus Caruaru",
    condition: "Bom",
    deliveryDate: new Date().toLocaleDateString("pt-BR"),
    status: "Disponível",
    invoice: "-",
    value: 0,
    notes: "",
    visibility: "Interno",
    updatedAt: new Date().toISOString(),
  };
  const [form, setForm] = useState<Asset>(asset || blank);
  const change = (key: keyof Asset, value: string | number) =>
    setForm({ ...form, [key]: value, updatedAt: new Date().toISOString() });
  return (
    <Modal
      title={asset ? "Editar patrimônio" : "Cadastrar patrimônio"}
      subtitle="Preencha os dados de identificação e localização"
      onClose={onClose}
      wide
    >
      <form
        className="asset-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(form);
        }}
      >
        <div className="form-section">
          <h3>Identificação</h3>
          <div className="form-grid">
            <Field label="Código patrimonial">
              <input
                required
                value={form.code}
                onChange={(e) => change("code", e.target.value)}
              />
            </Field>
            <Field label="Nome do equipamento">
              <input
                required
                value={form.name}
                onChange={(e) => change("name", e.target.value)}
              />
            </Field>
            <Field label="Categoria">
              <input
                value={form.category}
                onChange={(e) => change("category", e.target.value)}
              />
            </Field>
            <Field label="Marca">
              <input
                value={form.brand}
                onChange={(e) => change("brand", e.target.value)}
              />
            </Field>
            <Field label="Modelo">
              <input
                value={form.model}
                onChange={(e) => change("model", e.target.value)}
              />
            </Field>
            <Field label="Nº de série">
              <input
                value={form.serial}
                onChange={(e) => change("serial", e.target.value)}
              />
            </Field>
          </div>
        </div>
        <div className="form-section">
          <h3>Localização e situação</h3>
          <div className="form-grid">
            <Field label="Prédio">
              <input
                value={form.building}
                onChange={(e) => change("building", e.target.value)}
              />
            </Field>
            <Field label="Setor">
              <input
                value={form.sector}
                onChange={(e) => change("sector", e.target.value)}
              />
            </Field>
            <Field label="Sala / local">
              <input
                value={form.room}
                onChange={(e) => change("room", e.target.value)}
              />
            </Field>
            <Field label="Responsável">
              <input
                value={form.responsible}
                onChange={(e) => change("responsible", e.target.value)}
              />
            </Field>
            <Field label="Status">
              <select
                value={form.status}
                onChange={(e) => change("status", e.target.value)}
              >
                {[
                  "Em uso",
                  "Disponível",
                  "Emprestado",
                  "Em manutenção",
                  "Danificado",
                  "Extraviado",
                  "Baixado",
                ].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </Field>
            <Field label="Conservação">
              <input
                value={form.condition}
                onChange={(e) => change("condition", e.target.value)}
              />
            </Field>
          </div>
        </div>
        <div className="form-section">
          <h3>Controle e acesso</h3>
          <div className="form-grid">
            <Field label="Valor de aquisição">
              <input
                type="number"
                value={form.value}
                onChange={(e) => change("value", Number(e.target.value))}
              />
            </Field>
            <Field label="Nota fiscal">
              <input
                value={form.invoice}
                onChange={(e) => change("invoice", e.target.value)}
              />
            </Field>
            <Field label="Visibilidade">
              <select
                value={form.visibility}
                onChange={(e) => change("visibility", e.target.value)}
              >
                <option>Público</option>
                <option>Interno</option>
                <option>Restrito</option>
              </select>
            </Field>
          </div>
          <Field label="Observações">
            <textarea
              value={form.notes}
              onChange={(e) => change("notes", e.target.value)}
            />
          </Field>
        </div>
        <div className="form-actions">
          <button type="button" className="btn secondary" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary">
            <Check /> Salvar patrimônio
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function AssetDetail({
  asset,
  onClose,
  onEdit,
  onTransfer,
  canManage,
}: {
  asset: Asset;
  onClose: () => void;
  onEdit: () => void;
  onTransfer: () => void;
  canManage: boolean;
}) {
  return (
    <Modal
      title={asset.name}
      subtitle={`${asset.code} • Atualizado ${date(asset.updatedAt)}`}
      onClose={onClose}
      wide
    >
      <div className="detail-actions">
        <Status>{asset.status}</Status>
        <span className="spacer" />
        {canManage && <button className="btn secondary" onClick={onEdit}>
          <Pencil /> Editar
        </button>}
        {canManage && <button className="btn primary" onClick={onTransfer}>
          <ArrowLeftRight /> Transferir
        </button>}
      </div>
      <div className="detail-layout">
        <div>
          <div className="detail-card">
            <h3>Identificação do bem</h3>
            <div className="info-grid three">
              <Info label="Categoria">{asset.category}</Info>
              <Info label="Marca">{asset.brand}</Info>
              <Info label="Modelo">{asset.model}</Info>
              <Info label="Número de série">{asset.serial}</Info>
              <Info label="Conservação">{asset.condition}</Info>
              <Info label="Visibilidade">{asset.visibility}</Info>
            </div>
          </div>
          <div className="detail-card">
            <h3>Localização atual</h3>
            <div className="location-line">
              <Map />
              <div>
                <strong>{asset.room}</strong>
                <span>
                  {asset.sector} • {asset.building} • {asset.campus}
                </span>
              </div>
            </div>
            <Info label="Responsável">{asset.responsible}</Info>
          </div>
          <div className="detail-card">
            <h3>Linha do tempo</h3>
            <div className="timeline">
              <div>
                <i />
                <span>
                  <strong>Cadastro atualizado</strong>
                  <small>{date(asset.updatedAt)} • Dirceu</small>
                </span>
              </div>
              <div>
                <i />
                <span>
                  <strong>Patrimônio incorporado ao acervo</strong>
                  <small>{asset.deliveryDate} • Importação da planilha</small>
                </span>
              </div>
            </div>
          </div>
        </div>
        <aside className="qr-card">
          <BarcodeLabel code={asset.code} />
          <strong>Código patrimonial</strong>
          <span>Origem: coluna Nº Série</span>
          <button
            className="btn secondary full"
            onClick={() => window.print()}
          >
            <Download /> Imprimir etiqueta
          </button>
          <hr />
          <Info label="Valor de aquisição">{currency.format(asset.value)}</Info>
          <Info label="Nota fiscal">{asset.invoice}</Info>
        </aside>
      </div>
    </Modal>
  );
}

function TransferModal({
  asset,
  onClose,
  onSave,
}: {
  asset: Asset;
  onClose: () => void;
  onSave: (
    room: string,
    sector: string,
    responsible: string,
    reason: string,
  ) => void;
}) {
  const [room, setRoom] = useState("");
  const [sector, setSector] = useState(asset.sector);
  const [responsible, setResponsible] = useState(asset.responsible);
  const [reason, setReason] = useState("Reorganização de espaço");
  return (
    <Modal
      title="Transferir patrimônio"
      subtitle={`${asset.name} • ${asset.code}`}
      onClose={onClose}
    >
      <div className="transfer-route">
        <div>
          <span>Origem</span>
          <strong>{asset.room}</strong>
          <small>{asset.sector}</small>
        </div>
        <ArrowLeftRight />
        <div>
          <span>Destino</span>
          <strong>{room || "Selecione o local"}</strong>
          <small>{sector}</small>
        </div>
      </div>
      <Field label="Nova sala / local">
        <input
          autoFocus
          value={room}
          onChange={(e) => setRoom(e.target.value)}
          placeholder="Ex.: Laboratório 04"
        />
      </Field>
      <Field label="Novo setor">
        <input value={sector} onChange={(e) => setSector(e.target.value)} />
      </Field>
      <Field label="Novo responsável">
        <input
          value={responsible}
          onChange={(e) => setResponsible(e.target.value)}
        />
      </Field>
      <Field label="Motivo">
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <button
        disabled={!room}
        className="btn primary full"
        onClick={() => onSave(room, sector, responsible, reason)}
      >
        <Check /> Confirmar transferência
      </button>
    </Modal>
  );
}

function MapPage({
  assets,
  onOpen,
}: {
  assets: Asset[];
  onOpen: (a: Asset) => void;
}) {
  const [building, setBuilding] = useState("Todos");
  const rooms = Object.entries(
    assets
      .filter((a) => building === "Todos" || a.building === building)
      .reduce<Record<string, Asset[]>>((acc, a) => {
        const key = `${a.room} · ${a.sector}`;
        (acc[key] ??= []).push(a);
        return acc;
      }, {}),
  )
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 18);
  return (
    <>
      <div className="page-actions">
        <div>
          <h2>Mapa patrimonial</h2>
          <p>Navegue pelos espaços e visualize a distribuição do acervo.</p>
        </div>
        <label className="select-box">
          <Building2 />
          <select
            value={building}
            onChange={(e) => setBuilding(e.target.value)}
          >
            <option>Todos</option>
            <option>Bloco A</option>
            <option>Bloco B</option>
            <option>Bloco C</option>
          </select>
          <ChevronDown />
        </label>
      </div>
      <div className="map-breadcrumb">
        <Home />
        <span>Campus Caruaru</span>
        <ChevronRight />
        <strong>{building === "Todos" ? "Todos os prédios" : building}</strong>
      </div>
      <div className="room-grid">
        {rooms.map(([name, list], i) => (
          <article className="room" key={name}>
            <div className="room-top">
              <div className={`room-icon r${i % 4}`}>
                <Building2 />
              </div>
              <Status>
                {list.some((a) => a.status === "Em manutenção")
                  ? "Atenção"
                  : "Em uso"}
              </Status>
            </div>
            <h3>{name.split(" · ")[0]}</h3>
            <p>{name.split(" · ")[1]}</p>
            <div className="room-count">
              <strong>{list.length}</strong>
              <span>patrimônios</span>
            </div>
            <div className="room-meta">
              <span>
                <Boxes />
                {new Set(list.map((a) => a.category)).size} categorias
              </span>
              <span>
                <Wrench />
                {list.filter((a) => a.status === "Em manutenção").length} em
                manutenção
              </span>
            </div>
            <button onClick={() => onOpen(list[0])}>
              Ver patrimônios <ChevronRight />
            </button>
          </article>
        ))}
      </div>
    </>
  );
}

function InventoryPage({ assets, now }: { assets: Asset[]; now: Date }) {
  const [active, setActive] = useState(false);
  const [scanned, setScanned] = useState<Asset[]>([]);
  const [manualCode, setManualCode] = useState("");
  const [scanStatus, setScanStatus] = useState("Preparando câmera...");
  const [scanError, setScanError] = useState("");
  const [cameraAttempt, setCameraAttempt] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [scanDiagnostic, setScanDiagnostic] = useState("");
  const inventoryVideoRef = useRef<HTMLVideoElement>(null);
  const inventoryAssetsRef = useRef(assets);
  inventoryAssetsRef.current = assets;
  const expected = assets.filter((a) => a.building === "Bloco B").slice(0, 42);
  const registerCode = (value: string) => {
    const found = findAssetByBarcode(inventoryAssetsRef.current, value);
    if (!found) {
      setScanError(`Código ${value || "informado"} não encontrado no cadastro.`);
      return;
    }
    if (found.building !== "Bloco B" || !expected.some((asset) => asset.id === found.id)) {
      setScanError(`${found.code} pertence a ${found.building} e não faz parte deste inventário.`);
      return;
    }
    setScanError("");
    setManualCode(found.code);
    setScanStatus(`${found.code} — ${found.name} registrado.`);
    setScanned((current) =>
      current.some((asset) => asset.id === found.id) ? current : [...current, found],
    );
  };
  useEffect(() => {
    if (!active) return;
    let controls: IScannerControls | null = null;
    let stream: MediaStream | null = null;
    let nativeTimer: number | undefined;
    let quaggaTimer: number | undefined;
    let quaggaBusy = false;
    let stopped = false;
    let lastValue = "";
    let attempts = 0;
    let lastDiagnosticAt = 0;
    const handleRead = (value: string) => {
      if (stopped) return;
      const normalized = normalizeBarcode(value);
      if (!normalized || normalized === lastValue) return;
      lastValue = normalized;
      registerCode(value);
      window.setTimeout(() => {
        if (lastValue === normalized) lastValue = "";
      }, 1500);
    };
    const start = async () => {
      try {
        setScanError("");
        setScanStatus("Solicitando acesso à câmera...");
        const [{ BrowserMultiFormatOneDReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
          import("@zxing/browser"),
          import("@zxing/library"),
        ]);
        if (stopped || !inventoryVideoRef.current) return;
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Este navegador não oferece acesso à câmera.");
        const formats = [BarcodeFormat.CODABAR, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.ITF, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E];
        const hints = new globalThis.Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, formats);
        const reader = new BrowserMultiFormatOneDReader(hints, {
          delayBetweenScanAttempts: 140,
          delayBetweenScanSuccess: 700,
          tryPlayVideoTimeout: 5000,
        });
        const video = inventoryVideoRef.current;
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        if (stopped) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        await video.play();
        if (stopped) return;
        setScanStatus("Scanner ativo — centralize toda a largura do código.");
        controls = reader.scan(
          video,
          (result, scanAttemptError) => {
            if (stopped) return;
            if (result) {
              setScanDiagnostic(`Leitura concluída após ${attempts + 1} quadros analisados.`);
              handleRead(result.getText().trim());
              return;
            }
            if (scanAttemptError) {
              attempts += 1;
              const detail = describeBarcodeError(scanAttemptError);
              const currentTime = Date.now();
              if (currentTime - lastDiagnosticAt >= 1000) {
                lastDiagnosticAt = currentTime;
                setScanDiagnostic(`${attempts} quadros analisados — ${detail}.`);
              }
              if (attempts === 1 || !/nenhum padrão/i.test(detail)) {
                console.info(`[Inventário/leitor] tentativa ${attempts}: ${detail}`, scanAttemptError);
              }
            }
          },
        );
        const NativeDetector = getNativeBarcodeDetector();
        if (NativeDetector) {
          try {
            const detector = new NativeDetector();
            const detectWithBrowser = async () => {
              if (stopped) return;
              try {
                const [detected] = await detector.detect(video);
                if (detected?.rawValue) handleRead(detected.rawValue.trim());
              } catch {
                // ZXing remains active when the native detector rejects a frame.
              }
              if (!stopped) nativeTimer = window.setTimeout(detectWithBrowser, 180);
            };
            void detectWithBrowser();
          } catch {
            // The native API is optional; ZXing is the primary decoder.
          }
        }
        const detectWithQuagga = async () => {
          if (stopped || quaggaBusy) return;
          quaggaBusy = true;
          try {
            const value = await decodeVideoFrameWithQuagga(video);
            if (!stopped && value) {
              setScanDiagnostic("Quagga2 identificou o código no quadro atual.");
              handleRead(value);
            }
          } catch (error) {
            if (!stopped) setScanDiagnostic(`Quagga2: ${describeBarcodeError(error)}.`);
          } finally {
            quaggaBusy = false;
            if (!stopped) quaggaTimer = window.setTimeout(detectWithQuagga, 700);
          }
        };
        void detectWithQuagga();
      } catch (caught) {
        if (stopped) return;
        const name = caught instanceof DOMException ? caught.name : "";
        const message = name === "NotAllowedError"
          ? "Permissão da câmera negada. Autorize-a no navegador."
          : name === "NotFoundError"
            ? "Nenhuma câmera foi encontrada."
            : name === "NotReadableError"
              ? "A câmera está ocupada por outro aplicativo ou aba."
              : caught instanceof Error
                ? caught.message
                : "Não foi possível iniciar a câmera.";
        setScanStatus(message);
        setScanError("Você ainda pode informar a numeração manualmente.");
        setScanDiagnostic(`Falha ao iniciar: ${describeBarcodeError(caught)}.`);
      }
    };
    start();
    return () => {
      stopped = true;
      if (nativeTimer !== undefined) window.clearTimeout(nativeTimer);
      if (quaggaTimer !== undefined) window.clearTimeout(quaggaTimer);
      controls?.stop();
      stream?.getTracks().forEach((track) => track.stop());
      if (inventoryVideoRef.current?.srcObject === stream) inventoryVideoRef.current.srcObject = null;
    };
  }, [active, cameraAttempt]);
  const capturePhoto = async () => {
    if (!inventoryVideoRef.current || capturing) return;
    setCapturing(true);
    setScanError("");
    setScanStatus("Capturando e analisando a foto...");
    try {
      const value = await captureBarcodePhoto(inventoryVideoRef.current, (detail) => {
        setScanDiagnostic(detail);
        console.info(`[Inventário/foto] ${detail}`);
      });
      if (!value) {
        setScanError("Nenhum código foi localizado na foto. Aproxime a etiqueta, evite reflexos e tente novamente.");
        setScanStatus("Foto analisada — reposicione a etiqueta para uma nova captura.");
        return;
      }
      registerCode(value);
    } catch (caught) {
      setScanError(caught instanceof Error ? caught.message : "Não foi possível analisar a foto.");
      setScanStatus("Não foi possível capturar a foto.");
    } finally {
      setCapturing(false);
    }
  };
  return (
    <>
      <div className="page-actions">
        <div>
          <h2>Inventário inteligente</h2>
          <p>Confira patrimônios por código de barras ou numeração.</p>
        </div>
        {!active && (
          <button className="btn primary" onClick={() => setActive(true)}>
            <ScanLine /> Iniciar inventário
          </button>
        )}
      </div>
      {active ? (
        <div className="inventory-live">
          <section className="scanner-panel">
            <div className="camera compact">
              <video ref={inventoryVideoRef} muted playsInline autoPlay />
              <div className="corners" />
              <span>{scanStatus}</span>
            </div>
            <button className="btn primary full camera-capture" onClick={capturePhoto} disabled={capturing}>
              <ScanLine /> {capturing ? "Analisando foto..." : "Capturar e analisar foto"}
            </button>
            {scanDiagnostic && <div className="scanner-diagnostic"><strong>Diagnóstico</strong><span>{scanDiagnostic}</span></div>}
            <div className="scan-progress">
              <strong>
                Escaneados: {scanned.length} / {expected.length}
              </strong>
              <div>
                <i
                  style={{
                    width: `${(scanned.length / expected.length) * 100}%`,
                  }}
                />
              </div>
            </div>
            <label className="field inventory-code-field">
              <span>Código lido ou digitado</span>
              <input
                value={manualCode}
                onChange={(event) => setManualCode(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && registerCode(manualCode)}
                placeholder={expected[0]?.code || "Número do patrimônio"}
              />
            </label>
            {scanError && <div className="form-error"><AlertTriangle /> {scanError}</div>}
            <button className="btn primary full" onClick={() => registerCode(manualCode)}>
              <Barcode /> Registrar leitura
            </button>
            <button className="btn secondary full" onClick={() => setCameraAttempt((attempt) => attempt + 1)}>
              <RotateCcw /> Reiniciar câmera
            </button>
            <button
              className="btn secondary full"
              onClick={() => setActive(false)}
            >
              Finalizar inventário
            </button>
          </section>
          <section className="panel">
            <PanelHead
              title="Leituras desta sessão"
              subtitle="Inventário • Bloco B"
            />
            {scanned.length === 0 ? (
              <Empty
                title="Nenhum item escaneado"
                text="Use o scanner para iniciar a conferência."
              />
            ) : (
              <div className="scan-list">
                {scanned
                  .slice()
                  .reverse()
                  .map((a) => (
                    <div key={a.id}>
                      <Check />
                      <span>
                        <strong>{a.name}</strong>
                        <small>
                          {a.code} • {a.room}
                        </small>
                      </span>
                      <em>Encontrado</em>
                    </div>
                  ))}
              </div>
            )}
          </section>
        </div>
      ) : (
        <div className="inventory-grid">
          <article className="inventory-card featured">
            <span className="overline">EM ANDAMENTO</span>
            <h3>Inventário anual • Bloco B</h3>
            <p>Responsável: Dirceu</p>
            <div className="big-progress">
              <span>
                <strong>68%</strong>
                <small>concluído</small>
              </span>
              <div>
                <i style={{ width: "68%" }} />
              </div>
            </div>
            <div className="inventory-stats">
              <span>
                <strong>286</strong>esperados
              </span>
              <span>
                <strong>194</strong>encontrados
              </span>
              <span>
                <strong>5</strong>divergências
              </span>
            </div>
            <button className="btn primary" onClick={() => setActive(true)}>
              Continuar conferência <ChevronRight />
            </button>
          </article>
          <article className="inventory-card">
            <ClipboardCheck />
            <h3>Laboratório de Informática</h3>
            <p>Concluído em {new Date(now.getFullYear(), now.getMonth(), now.getDate() - 12).toLocaleDateString("pt-BR")}</p>
            <Status>Concluído</Status>
            <div className="inventory-stats">
              <span>
                <strong>42</strong>itens
              </span>
              <span>
                <strong>0</strong>pendências
              </span>
            </div>
          </article>
          <article className="inventory-card">
            <Clock3 />
            <h3>Coordenação Administrativa</h3>
            <p>Agendado para {new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7).toLocaleDateString("pt-BR")}</p>
            <Status>Aguardando manutenção</Status>
            <div className="inventory-stats">
              <span>
                <strong>78</strong>itens
              </span>
              <span>
                <strong>—</strong>conferidos
              </span>
            </div>
          </article>
        </div>
      )}
    </>
  );
}

function MovementPage({ movements }: { movements: Movement[] }) {
  return (
    <>
      <div className="page-actions">
        <div>
          <h2>Movimentações</h2>
          <p>Histórico permanente de transferências e alterações.</p>
        </div>
        <button className="btn secondary">
          <Download /> Exportar histórico
        </button>
      </div>
      <section className="panel table-panel">
        {movements.length === 0 ? (
          <Empty
            title="Nenhuma movimentação registrada"
            text="As transferências aparecerão aqui automaticamente."
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Patrimônio</th>
                  <th>Rota</th>
                  <th>Responsáveis</th>
                  <th>Data</th>
                </tr>
              </thead>
              <tbody>
                {movements.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <strong>{m.assetName}</strong>
                      <small>{m.assetCode}</small>
                    </td>
                    <td>
                      <div className="route">
                        <span>{m.from}</span>
                        <ChevronRight />
                        <strong>{m.to}</strong>
                      </div>
                      <small>{m.reason}</small>
                    </td>
                    <td>
                      {m.previousResponsible}
                      <br />
                      <strong>{m.newResponsible}</strong>
                    </td>
                    <td>
                      {date(m.createdAt)}
                      <small>{m.user}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function LoansPage({
  assets,
  loans,
  setLoans,
  setAssets,
}: {
  assets: Asset[];
  loans: Loan[];
  setLoans: (l: Loan[]) => void;
  setAssets: (a: Asset[]) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [assetId, setAssetId] = useState("");
  const [requester, setRequester] = useState("");
  const [due, setDue] = useState("");
  const save = async () => {
    const a = assets.find((x) => x.id === assetId);
    if (!a) return;
    let loan: Loan = {
        id: `loan-${Date.now()}`,
        assetId: a.id,
        assetCode: a.code,
        assetName: a.name,
        requester,
        dueDate: due,
        status: "Emprestado",
        createdAt: new Date().toISOString(),
      };
    if (hasApi()) {
      try { loan = await api<Loan>("/loans", { method: "POST", body: JSON.stringify({ assetId: a.id, requester, dueDate: `${due}T12:00:00` }) }); }
      catch (cause) { alert(cause instanceof Error ? cause.message : "Falha ao registrar empréstimo."); return; }
    }
    setLoans([loan, ...loans]);
    setAssets(
      assets.map((x) => (x.id === a.id ? { ...x, status: "Emprestado" } : x)),
    );
    setCreating(false);
  };
  return (
    <>
      <div className="page-actions">
        <div>
          <h2>Empréstimos</h2>
          <p>Registre entregas, acompanhe prazos e devoluções.</p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Plus /> Novo empréstimo
        </button>
      </div>
      <div className="mini-kpis">
        <span>
          <strong>
            {loans.filter((l) => l.status === "Emprestado").length}
          </strong>
          em aberto
        </span>
        <span>
          <strong>{loans.filter((l) => l.status === "Atrasado").length}</strong>
          atrasados
        </span>
        <span>
          <strong>
            {loans.filter((l) => l.status === "Devolvido").length}
          </strong>
          devolvidos
        </span>
      </div>
      <section className="panel table-panel">
        {loans.length === 0 ? (
          <Empty
            title="Nenhum empréstimo"
            text="Registre o primeiro empréstimo para começar."
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Equipamento</th>
                  <th>Solicitante</th>
                  <th>Previsão</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {loans.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <strong>{l.assetName}</strong>
                      <small>{l.assetCode}</small>
                    </td>
                    <td>{l.requester}</td>
                    <td>{l.dueDate || "Não definida"}</td>
                    <td>
                      <Status>{l.status}</Status>
                    </td>
                    <td>
                      {l.status !== "Devolvido" && (
                        <button
                          className="text-btn"
                          onClick={async () => {
                            let returned: Loan = { ...l, status: "Devolvido" };
                            if (hasApi()) {
                              try { returned = await api<Loan>(`/loans/${l.id}`, { method: "PATCH", body: JSON.stringify({ status: "Devolvido" }) }); }
                              catch (cause) { alert(cause instanceof Error ? cause.message : "Falha ao registrar devolução."); return; }
                            }
                            setLoans(
                              loans.map((x) =>
                                x.id === l.id
                                  ? returned
                                  : x,
                              ),
                            );
                            setAssets(
                              assets.map((a) =>
                                a.id === l.assetId
                                  ? { ...a, status: "Disponível" }
                                  : a,
                              ),
                            );
                          }}
                        >
                          Registrar devolução
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {creating && (
        <Modal
          title="Novo empréstimo"
          subtitle="O status do patrimônio será atualizado automaticamente"
          onClose={() => setCreating(false)}
        >
          <Field label="Equipamento">
            <select
              value={assetId}
              onChange={(e) => setAssetId(e.target.value)}
            >
              <option value="">Selecione...</option>
              {assets
                .filter(
                  (a) => a.status === "Disponível" || a.status === "Em uso",
                )
                .slice(0, 100)
                .map((a) => (
                  <option value={a.id} key={a.id}>
                    {a.code} • {a.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Solicitante">
            <input
              value={requester}
              onChange={(e) => setRequester(e.target.value)}
              placeholder="Nome e setor"
            />
          </Field>
          <Field label="Previsão de devolução">
            <input
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          </Field>
          <button
            className="btn primary full"
            disabled={!assetId || !requester || !due}
            onClick={save}
          >
            <Check /> Registrar empréstimo
          </button>
        </Modal>
      )}
    </>
  );
}

function MaintenancePage({
  assets,
  items,
  setItems,
  setAssets,
  onNotify,
  user,
}: {
  assets: Asset[];
  items: Maintenance[];
  setItems: (v: Maintenance[]) => void;
  setAssets: (v: Asset[]) => void;
  onNotify: (message: string) => void;
  user: SessionUser;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Maintenance | null>(null);
  const [assetId, setAssetId] = useState("");
  const [issue, setIssue] = useState("");
  const allowedAssets = user.role === "nti" ? assets.filter(isElectronicAsset) : assets;
  const allowedAssetIds = new Set(allowedAssets.map((asset) => asset.id));
  const visibleItems = user.role === "nti" ? items.filter((item) => allowedAssetIds.has(item.assetId)) : items;
  const advanceItem = async (item: Maintenance) => {
    if (user.role === "nti" && !allowedAssetIds.has(item.assetId)) {
      onNotify("O NTI pode realizar manutenção apenas em equipamentos eletrônicos.");
      return;
    }
    const next: Maintenance["status"] = item.status === "Aguardando manutenção"
      ? "Em manutenção"
      : item.status === "Em manutenção"
        ? "Aguardando peça"
        : "Concluído";
    let updated: Maintenance = { ...item, status: next };
    if (hasApi()) {
      try { updated = await api<Maintenance>(`/maintenances/${item.id}`, { method: "PATCH", body: JSON.stringify({ status: next }) }); }
      catch (cause) { onNotify(cause instanceof Error ? cause.message : "Falha ao atualizar manutenção."); return; }
    }
    setItems(items.map((current) => current.id === item.id ? updated : current));
    if (next === "Concluído") {
      setAssets(assets.map((asset) => asset.id === item.assetId ? { ...asset, status: "Disponível" } : asset));
    }
    setSelected(updated);
    onNotify(`Manutenção avançada para “${next}”.`);
  };
  const save = async () => {
    const a = allowedAssets.find((x) => x.id === assetId);
    if (!a) return;
    let maintenance: Maintenance = {
        id: `mnt-${Date.now()}`,
        assetId: a.id,
        assetCode: a.code,
        assetName: a.name,
        issue,
        technician: "A definir",
        status: "Aguardando manutenção",
        openedAt: new Date().toISOString(),
        cost: 0,
      };
    if (hasApi()) {
      try { maintenance = await api<Maintenance>("/maintenances", { method: "POST", body: JSON.stringify({ assetId: a.id, issue, technician: "A definir" }) }); }
      catch (cause) { onNotify(cause instanceof Error ? cause.message : "Falha ao abrir manutenção."); return; }
    }
    setItems([maintenance, ...items]);
    setAssets(
      assets.map((x) =>
        x.id === a.id ? { ...x, status: "Em manutenção" } : x,
      ),
    );
    setOpen(false);
  };
  return (
    <>
      <div className="page-actions">
        <div>
          <h2>Manutenção</h2>
          <p>{user.role === "nti" ? "Área restrita à manutenção de equipamentos eletrônicos." : "Acompanhe chamados, técnicos, custos e prazos."}</p>
        </div>
        <button className="btn primary" onClick={() => setOpen(true)}>
          <Plus /> Abrir manutenção
        </button>
      </div>
      <div className="maintenance-board">
        {[
          "Aguardando manutenção",
          "Em manutenção",
          "Aguardando peça",
          "Concluído",
        ].map((status) => (
          <section key={status}>
            <header>
              <span>{status}</span>
              <b>{visibleItems.filter((i) => i.status === status).length}</b>
            </header>
            {visibleItems
              .filter((i) => i.status === status)
              .map((i) => (
                <article key={i.id}>
                  <Status>{i.status}</Status>
                  <h3>{i.assetName}</h3>
                  <code>{i.assetCode}</code>
                  <p>{i.issue}</p>
                  <span>
                    <Clock3 />
                    {date(i.openedAt)}
                  </span>
                  {status !== "Concluído" && (
                    <button
                      onClick={() => setSelected(i)}
                    >
                      Abrir e avançar etapa <ChevronRight />
                    </button>
                  )}
                </article>
              ))}
            {visibleItems.filter((i) => i.status === status).length === 0 && (
              <div className="board-empty">Nenhum chamado</div>
            )}
          </section>
        ))}
      </div>
      {open && (
        <Modal
          title="Abrir manutenção"
          subtitle="Registre o problema identificado"
          onClose={() => setOpen(false)}
        >
          <Field label="Patrimônio">
            <select
              value={assetId}
              onChange={(e) => setAssetId(e.target.value)}
            >
              <option value="">Selecione...</option>
              {allowedAssets.slice(0, 100).map((a) => (
                <option value={a.id} key={a.id}>
                  {a.code} • {a.name}
                </option>
              ))}
            </select>
          </Field>
          {user.role === "nti" && <div className="access-note"><ShieldCheck /> Somente equipamentos eletrônicos são exibidos para o NTI.</div>}
          <Field label="Defeito / problema">
            <textarea
              value={issue}
              onChange={(e) => setIssue(e.target.value)}
              placeholder="Descreva o problema..."
            />
          </Field>
          <button
            className="btn primary full"
            disabled={!assetId || !issue}
            onClick={save}
          >
            <Wrench /> Abrir solicitação
          </button>
        </Modal>
      )}
      {selected && (
        <Modal title={selected.assetName} subtitle={`Manutenção • ${selected.assetCode}`} onClose={() => setSelected(null)}>
          <div className="stage-detail">
            <div><span>Etapa atual</span><Status>{selected.status}</Status></div>
            <div><span>Defeito informado</span><p>{selected.issue}</p></div>
            <div><span>Técnico responsável</span><strong>{selected.technician}</strong></div>
            <div><span>Aberto em</span><strong>{date(selected.openedAt)}</strong></div>
          </div>
          {selected.status !== "Concluído" && (
            <button className="btn primary full" onClick={() => advanceItem(selected)}>
              <ChevronRight /> Avançar para {selected.status === "Aguardando manutenção" ? "Em manutenção" : selected.status === "Em manutenção" ? "Aguardando peça" : "Concluído"}
            </button>
          )}
        </Modal>
      )}
    </>
  );
}

function ChecklistRunner({
  template,
  inspection,
  scheduledDate,
  inspector,
  onClose,
  onSave,
}: {
  template: ChecklistTemplate;
  inspection?: Inspection;
  scheduledDate: string;
  inspector: string;
  onClose: () => void;
  onSave: (inspection: Inspection) => void;
}) {
  const [completed, setCompleted] = useState<string[]>(inspection?.completedItems || []);
  const [notes, setNotes] = useState(inspection?.notes || "");
  const toggle = (item: string) => setCompleted((current) => current.includes(item) ? current.filter((value) => value !== item) : [...current, item]);
  const save = () => {
    const status: Inspection["status"] = completed.length === template.items.length ? "Concluída" : completed.length ? "Em andamento" : "Agendada";
    onSave({
      id: inspection?.id || `inspection-${Date.now()}`,
      templateId: template.id,
      templateName: template.name,
      location: template.location,
      inspector: inspection?.inspector || inspector,
      scheduledDate,
      notes,
      completedItems: completed,
      totalItems: template.items.length,
      status,
      createdAt: inspection?.createdAt || new Date().toISOString(),
    });
  };
  return (
    <Modal title={template.name} subtitle={`${template.location} • ${new Date(`${scheduledDate}T12:00:00`).toLocaleDateString("pt-BR")}`} onClose={onClose} wide>
      <div className="checklist-runner-head">
        <span><UserRound /> Responsável: <strong>{inspection?.inspector || inspector}</strong></span>
        <span><Check /> {completed.length} de {template.items.length} realizados</span>
      </div>
      <div className="checklist-items">
        {template.items.map((item, index) => {
          const checked = completed.includes(item);
          return <label className={checked ? "checked" : ""} key={item}>
            <input type="checkbox" checked={checked} onChange={() => toggle(item)} />
            <i>{checked ? <Check /> : index + 1}</i>
            <span><strong>{item}</strong><small>{checked ? "Atividade realizada" : "Pendente de conferência"}</small></span>
          </label>;
        })}
      </div>
      <div className="checklist-actions-inline">
        <button onClick={() => setCompleted(template.items)}><Check /> Marcar todos</button>
        <button onClick={() => setCompleted([])}><X /> Limpar marcações</button>
      </div>
      <Field label="Observações da vistoria"><textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Registre danos, divergências ou providências necessárias..." /></Field>
      <button className="btn primary full" onClick={save}><ClipboardCheck /> Salvar checklist</button>
    </Modal>
  );
}

function InspectionsPage({
  templates,
  inspections,
  setInspections,
  user,
  onNotify,
  now,
}: {
  templates: ChecklistTemplate[];
  inspections: Inspection[];
  setInspections: (items: Inspection[]) => void;
  user: SessionUser;
  onNotify: (message: string) => void;
  now: Date;
}) {
  const [tab, setTab] = useState<"inspections" | "templates" | "calendar">("inspections");
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [templateId, setTemplateId] = useState(templates[0]?.id || "");
  const [scheduledDate, setScheduledDate] = useState(localIsoDate(nextBusinessDate(now)));
  const [calendarMonth, setCalendarMonth] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1));
  const [activeChecklist, setActiveChecklist] = useState<{ template: ChecklistTemplate; date: string; inspection?: Inspection } | null>(null);
  const openChecklist = (template: ChecklistTemplate, dateValue: string) => {
    const inspection = inspections.find((item) => item.templateId === template.id && item.scheduledDate === dateValue);
    setActiveChecklist({ template, date: dateValue, inspection });
  };
  const saveChecklist = async (inspection: Inspection) => {
    const exists = inspections.some((item) => item.id === inspection.id);
    if (!exists && !isBusinessDateValue(inspection.scheduledDate)) {
      onNotify("Os checklists só podem ser agendados de segunda a sexta-feira.");
      return;
    }
    let saved = inspection;
    if (hasApi()) {
      try {
        saved = await api<Inspection>(exists ? `/inspections/${inspection.id}` : "/inspections", {
          method: exists ? "PATCH" : "POST",
          body: JSON.stringify(exists ? { notes: inspection.notes, completedItems: inspection.completedItems, status: inspection.status } : { templateId: inspection.templateId, scheduledDate: `${inspection.scheduledDate}T12:00:00`, notes: inspection.notes, completedItems: inspection.completedItems, totalItems: inspection.totalItems, status: inspection.status }),
        });
      } catch (cause) { onNotify(cause instanceof Error ? cause.message : "Falha ao salvar vistoria."); return; }
    }
    setInspections(exists ? inspections.map((item) => item.id === saved.id ? saved : item) : [saved, ...inspections]);
    setActiveChecklist(null);
    onNotify(inspection.status === "Concluída" ? "Checklist concluído e registrado." : "Progresso do checklist salvo.");
  };
  const downloadTemplate = (template: ChecklistTemplate) => {
    const rows = [
      ["Local", "Item de verificação", "Realizado", "Observações"],
      ...template.items.map((item) => [template.location, item, "", ""]),
    ];
    downloadXlsx(`checklist-${template.location}`, "Checklist", rows);
    onNotify("Modelo de checklist baixado em Excel.");
  };
  const calendarEvents = templates.map((template, index) => {
    const dueDate = monthlyChecklistDate(calendarMonth, index);
    const dateValue = localIsoDate(dueDate);
    const inspection = inspections.find((item) => item.templateId === template.id && item.scheduledDate === dateValue);
    return { template, dueDate, dateValue, inspection };
  });
  const daysInMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
  const businessDays = Array.from({ length: daysInMonth }, (_, index) => index + 1).filter((day) =>
    isBusinessDay(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), day)),
  );
  const firstBusinessDay = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), businessDays[0]);
  const leadingDays = firstBusinessDay.getDay() - 1;
  const monthLabel = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(calendarMonth);
  return (
    <>
      <div className="page-actions">
        <div><h2>Vistorias</h2><p>Checklists mensais com marcação item a item, calendário e alertas.</p></div>
        {tab === "inspections" && <button className="btn primary" onClick={() => setScheduleOpen(true)}><Plus /> Nova vistoria</button>}
      </div>
      <div className="section-tabs">
        <button className={tab === "inspections" ? "active" : ""} onClick={() => setTab("inspections")}><ClipboardCheck /> Vistorias</button>
        <button className={tab === "templates" ? "active" : ""} onClick={() => setTab("templates")}><ListChecks /> Modelos prontos</button>
        <button className={tab === "calendar" ? "active" : ""} onClick={() => setTab("calendar")}><CalendarDays /> Calendário mensal</button>
      </div>
      {tab === "templates" ? (
        <div className="template-grid">
          {templates.map((template) => <article className="panel template-card" key={template.id}>
            <span><MapPin /> {template.location}</span>
            <h3>{template.name}</h3>
            <ul>{template.items.map((item) => <li key={item}><Check /> {item}</li>)}</ul>
            <div className="template-actions"><button onClick={() => downloadTemplate(template)}><Download /> Baixar Excel</button><button onClick={() => openChecklist(template, localIsoDate(nextBusinessDate(now)))}><ClipboardCheck /> Preencher</button></div>
          </article>)}
        </div>
      ) : tab === "calendar" ? (
        <section className="panel checklist-calendar">
          <header><button onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}><ChevronRight /></button><h3>{monthLabel}</h3><button onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}><ChevronRight /></button></header>
          <div className="calendar-legend"><span className="planned">Programado</span><span className="soon">Próximo</span><span className="today">Hoje</span><span className="overdue">Atrasado</span><span className="completed">Concluído</span></div>
          <div className="calendar-grid calendar-weekdays">{["Seg", "Ter", "Qua", "Qui", "Sex"].map((day) => <strong key={day}>{day}</strong>)}</div>
          <div className="calendar-grid calendar-days">
            {Array.from({ length: leadingDays }, (_, index) => <div className="outside" key={`blank-${index}`} />)}
            {businessDays.map((day) => {
              const events = calendarEvents.filter((event) => event.dueDate.getDate() === day);
              return <div className={localIsoDate(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), day)) === localIsoDate(now) ? "current-day" : ""} key={day}><b>{day}</b>{events.map((event) => {
                const remaining = daysBetween(now, event.dueDate);
                const tone = event.inspection?.status === "Concluída" ? "completed" : remaining < 0 ? "overdue" : remaining === 0 ? "today" : remaining <= 5 ? "soon" : "planned";
                return <button className={tone} title={event.template.location} key={event.template.id} onClick={() => openChecklist(event.template, event.dateValue)}>{event.template.location}</button>;
              })}</div>;
            })}
          </div>
          <footer><CalendarDays /> Cada local recebe automaticamente uma data mensal em dia útil. Os alertas aparecem cinco dias antes e no dia programado.</footer>
        </section>
      ) : inspections.length ? (
        <div className="inspection-grid">
          {inspections.map((inspection) => {
            const template = templates.find((item) => item.id === inspection.templateId);
            const progress = Math.round((inspection.completedItems.length / inspection.totalItems) * 100) || 0;
            return <article className="panel inspection-card" key={inspection.id}>
              <header><Status>{inspection.status}</Status><span><CalendarDays /> {new Date(`${inspection.scheduledDate}T12:00:00`).toLocaleDateString("pt-BR")}</span></header>
              <h3>{inspection.location}</h3><p>{inspection.templateName}</p>
              <div className="inspection-meta"><span>Responsável<strong>{inspection.inspector}</strong></span><span>Progresso<strong>{inspection.completedItems.length}/{inspection.totalItems}</strong></span></div>
              <div className="inspection-progress"><i style={{ width: `${progress}%` }} /></div>
              {inspection.notes && <small>{inspection.notes}</small>}
              {template && <button className="btn secondary full" onClick={() => openChecklist(template, inspection.scheduledDate)}><ClipboardCheck /> {inspection.status === "Concluída" ? "Revisar checklist" : "Abrir checklist"}</button>}
            </article>;
          })}
        </div>
      ) : <Empty title="Nenhuma vistoria registrada" text="Abra o calendário mensal ou crie uma vistoria para iniciar a conferência." />}
      {scheduleOpen && <Modal title="Agendar vistoria" subtitle="Selecione o local e a data" onClose={() => setScheduleOpen(false)}>
        <Field label="Modelo e local"><select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>{templates.map((template) => <option value={template.id} key={template.id}>{template.location} — {template.name}</option>)}</select></Field>
        <Field label="Data da vistoria"><input type="date" value={scheduledDate} onChange={(event) => setScheduledDate(event.target.value)} /></Field>
        <Field label="Responsável"><input value={`${user.name} (${user.label})`} disabled /></Field>
        <button className="btn primary full" disabled={!templateId || !scheduledDate} onClick={() => { const template = templates.find((item) => item.id === templateId); if (!isBusinessDateValue(scheduledDate)) { onNotify("Selecione uma data de segunda a sexta-feira."); return; } if (template) { setScheduleOpen(false); openChecklist(template, scheduledDate); } }}><ClipboardCheck /> Abrir checklist</button>
      </Modal>}
      {activeChecklist && <ChecklistRunner key={`${activeChecklist.template.id}-${activeChecklist.date}`} template={activeChecklist.template} inspection={activeChecklist.inspection} scheduledDate={activeChecklist.date} inspector={user.name} onClose={() => setActiveChecklist(null)} onSave={saveChecklist} />}
    </>
  );
}

function TicketsPage({ tickets, setTickets, onNotify, user, assets }: { tickets: SupportTicket[]; setTickets: (items: SupportTicket[]) => void; onNotify: (message: string) => void; user: SessionUser; assets: Asset[] }) {
  const columns: TicketStatus[] = ["Novo", "Em triagem", "Em atendimento", "Resolvido"];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const visibleTickets = tickets.filter((ticket) => canHandleTicket(ticket, user, assets));
  const selected = visibleTickets.find((ticket) => ticket.id === selectedId) || null;
  const nextStatus = (status: TicketStatus): TicketStatus => columns[Math.min(columns.indexOf(status) + 1, columns.length - 1)];
  const advance = async (ticket: SupportTicket) => {
    if (!canHandleTicket(ticket, user, assets)) {
      onNotify("O NTI pode atender somente chamados de equipamentos eletrônicos.");
      return;
    }
    const next = nextStatus(ticket.status);
    let updated = { ...ticket, status: next };
    if (hasApi()) {
      try { updated = await api<SupportTicket>(`/tickets/${ticket.id}`, { method: "PATCH", body: JSON.stringify({ status: next }) }); }
      catch (cause) { onNotify(cause instanceof Error ? cause.message : "Falha ao atualizar chamado."); return; }
    }
    setTickets(tickets.map((item) => item.id === ticket.id ? updated : item));
    onNotify(`Chamado avançado para “${next}”.`);
  };
  return (
    <>
      <div className="page-actions"><div><h2>Chamados</h2><p>Mensagens de suporte e danos enviados pelos usuários.</p></div></div>
      <div className="ticket-summary">
        <span><strong>{visibleTickets.filter((item) => item.status !== "Resolvido").length}</strong>abertos</span>
        <span><strong>{visibleTickets.filter((item) => item.category === "Equipamento danificado").length}</strong>danos eletrônicos</span>
        <span><strong>{user.role === "nti" ? "Somente eletrônicos" : "Administrativo + NTI"}</strong>{user.role === "nti" ? "escopo de atendimento do NTI" : "notificados conforme o tipo do bem"}</span>
      </div>
      <div className="maintenance-board ticket-board">
        {columns.map((status) => <section key={status}><header><span>{status}</span><b>{visibleTickets.filter((item) => item.status === status).length}</b></header>
          {visibleTickets.filter((item) => item.status === status).map((ticket) => <article key={ticket.id}>
            <Status>{ticket.status}</Status><h3>{ticket.category}</h3>
            {ticket.assetCode && <code>{ticket.assetCode} • {ticket.assetName}</code>}
            <p>{ticket.description}</p>
            <div className="ticket-details"><span><MapPin /> {ticket.location}</span><span><UserRound /> {ticket.requester}</span><span><Clock3 /> {date(ticket.createdAt)}</span></div>
            <small>Notificados: {ticket.audience.join(" e ")}</small>
            <button onClick={() => setSelectedId(ticket.id)}>Abrir chamado <ChevronRight /></button>
          </article>)}
          {!visibleTickets.some((item) => item.status === status) && <div className="board-empty">Nenhum chamado</div>}
        </section>)}
      </div>
      {selected && <Modal title={selected.category} subtitle={`Chamado de ${selected.requester}`} onClose={() => setSelectedId(null)}>
        <div className="stage-detail">
          <div><span>Etapa atual</span><Status>{selected.status}</Status></div>
          {selected.assetCode && <div><span>Equipamento</span><strong>{selected.assetCode} • {selected.assetName}</strong></div>}
          <div><span>Descrição</span><p>{selected.description}</p></div>
          <div><span>Local</span><strong>{selected.location}</strong></div>
          <div><span>Solicitante</span><strong>{selected.requester} {selected.contact && `• ${selected.contact}`}</strong></div>
          <div><span>Notificados</span><strong>{selected.audience.join(" e ")}</strong></div>
        </div>
        {selected.status !== "Resolvido" && <button className="btn primary full" onClick={() => advance(selected)}><ChevronRight /> Avançar para {nextStatus(selected.status)}</button>}
      </Modal>}
    </>
  );
}

function Reports({ assets }: { assets: Asset[] }) {
  const exportExcel = () => {
    const rows: (string | number)[][] = [
      ["Código", "Nome", "Categoria", "Status", "Setor", "Local", "Valor"],
      ...assets.map((a) => [
        a.code,
        a.name,
        a.category,
        a.status,
        a.sector,
        a.room,
        a.value,
      ]),
    ];
    downloadXlsx("relatorio-patrimonio", "Patrimônio", rows);
  };
  const reports = [
    ["Patrimônio geral", "Todos os bens, localização e situação", Boxes],
    [
      "Patrimônio por setor",
      "Distribuição por unidade administrativa",
      Building2,
    ],
    ["Equipamentos em manutenção", "Chamados, prazos e custos", Wrench],
    [
      "Histórico de movimentações",
      "Transferências e responsáveis",
      ArrowLeftRight,
    ],
    ["Valores patrimoniais", "Consolidação financeira do acervo", BarChart3],
    ["Inventários", "Resultados e divergências", ClipboardCheck],
  ];
  return (
    <>
      <div className="page-actions">
        <div>
          <h2>Relatórios</h2>
          <p>Gere documentos gerenciais com dados atualizados.</p>
        </div>
        <button className="btn primary" onClick={exportExcel}>
          <Download /> Exportar Excel
        </button>
      </div>
      <div className="report-grid">
        {reports.map(([title, desc, Icon]) => (
          <article key={String(title)}>
            <div>
              <Icon />
              <span>RELATÓRIO</span>
            </div>
            <h3>{String(title)}</h3>
            <p>{String(desc)}</p>
            <div>
              <button onClick={exportExcel}>
                <Download /> Excel
              </button>
              <button onClick={() => window.print()}>
                <FileBarChart /> PDF
              </button>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

function ChatPanel({
  assets,
  publicMode = false,
  onClose,
}: {
  assets: Asset[];
  publicMode?: boolean;
  onClose?: () => void;
}) {
  const [messages, setMessages] = useState<
    { from: "bot" | "user"; text: string }[]
  >([
    {
      from: "bot",
      text: publicMode
        ? "Olá! Posso ajudar com informações públicas sobre patrimônios e espaços da UPE."
        : "Olá, Dirceu! Posso consultar a base patrimonial para você. O que deseja saber?",
    },
  ]);
  const [input, setInput] = useState("");
  const answer = (q: string) => {
    const lower = q.toLowerCase();
    let text =
      "Não encontrei essa informação ou ela não está disponível para consulta pública.";
    if (lower.includes("quantos") && lower.includes("notebook")) {
      const n = assets.filter((a) =>
        `${a.name} ${a.category}`.toLowerCase().includes("notebook"),
      ).length;
      text = `Encontrei ${n} notebooks ${publicMode ? "na consulta pública" : "cadastrados no acervo"}.`;
    } else if (lower.includes("manuten")) {
      const list = assets.filter((a) => a.status === "Em manutenção");
      text = `Há ${list.length} equipamentos em manutenção.${
        publicMode
          ? ""
          : " Os primeiros são: " +
            list
              .slice(0, 3)
              .map((a) => `${a.name} (${a.code})`)
              .join(", ") +
            "."
      }`;
    } else {
      const found = assets.find(
        (a) =>
          lower.includes(a.code.toLowerCase()) ||
          lower.includes(a.name.toLowerCase()),
      );
      if (found)
        text = publicMode
          ? `${found.name} — código ${found.code}, status ${found.status}, localizado em ${found.room}.`
          : `${found.name} (${found.code}) está ${found.status.toLowerCase()} em ${found.room}, ${found.sector}. Responsável: ${found.responsible}.`;
      else if (lower.includes("dispon"))
        text = `Há ${assets.filter((a) => a.status === "Disponível").length} equipamentos disponíveis.`;
    }
    setMessages((m) => [
      ...m,
      { from: "user", text: q },
      { from: "bot", text },
    ]);
    setInput("");
  };
  return (
    <div className={onClose ? "chat-float" : "chat-page"}>
      <section className="chat-box">
        <header>
          <div className="bot-avatar">
            <Bot />
          </div>
          <div>
            <strong>Assistente Patrimonial</strong>
            <span>
              <i /> {publicMode ? "Modo público" : "Conectado à base interna"}
            </span>
          </div>
          {onClose && (
            <button className="icon-btn" onClick={onClose}>
              <X />
            </button>
          )}
        </header>
        <div className="chat-messages">
          {messages.map((m, i) => (
            <div className={m.from} key={i}>
              {m.from === "bot" && <Bot />}
              <p>{m.text}</p>
            </div>
          ))}
        </div>
        <div className="chat-suggestions">
          {(publicMode
            ? ["Quantos notebooks há?", "Quais itens estão disponíveis?"]
            : [
                "Quais equipamentos estão em manutenção?",
                "Quantos notebooks temos?",
              ]
          ).map((q) => (
            <button key={q} onClick={() => answer(q)}>
              {q}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim()) answer(input);
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Digite sua pergunta..."
          />
          <button>
            <ChevronRight />
          </button>
        </form>
        <small>
          <ShieldCheck /> Respostas baseadas apenas nos dados autorizados.
        </small>
      </section>
    </div>
  );
}

function UsersPage() {
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "ALUNO" as ApiRole });
  const labels: Record<ApiRole, string> = { ALUNO: "Aluno", TI: "TI", ADMINISTRACAO: "Administração", ADMIN: "Administrador" };
  useEffect(() => { api<ApiUser[]>("/users").then(setUsers).catch((cause) => setError(cause instanceof Error ? cause.message : "Falha ao carregar usuários.")); }, []);
  const create = async () => {
    setError("");
    try {
      const created = await api<ApiUser>("/users", { method: "POST", body: JSON.stringify(form) });
      setUsers([...users, created]); setOpen(false); setForm({ name: "", email: "", password: "", role: "ALUNO" });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao criar usuário."); }
  };
  const toggle = async (account: ApiUser) => {
    try {
      const updated = await api<ApiUser>(`/users/${account.id}`, { method: "PATCH", body: JSON.stringify({ active: !account.active }) });
      setUsers(users.map((item) => item.id === account.id ? updated : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao atualizar usuário."); }
  };
  return <>
    <div className="page-actions"><div><h2>Usuários e permissões</h2><p>Gerencie contas de aluno, TI, administração e administradores.</p></div><button className="btn primary" onClick={() => setOpen(true)}><Plus /> Novo usuário</button></div>
    {error && <div className="form-error"><AlertTriangle />{error}</div>}
    <section className="panel simple-settings">{users.map((account) => <div className="user-row" key={account.id}><div className="avatar">{account.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2)}</div><span><strong>{account.name}</strong><small>{account.email}</small></span><button className="text-btn" onClick={() => toggle(account)}>{account.active ? "Desativar" : "Ativar"}</button><em>{labels[account.role]}</em></div>)}</section>
    {open && <Modal title="Novo usuário" subtitle="A senha inicial deve possuir pelo menos oito caracteres" onClose={() => setOpen(false)}><Field label="Nome"><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field><Field label="E-mail"><input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field><Field label="Senha inicial"><input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></Field><Field label="Perfil"><select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as ApiRole })}>{(Object.keys(labels) as ApiRole[]).map((role) => <option value={role} key={role}>{labels[role]}</option>)}</select></Field><button className="btn primary full" disabled={!form.name || !form.email || form.password.length < 8} onClick={create}><Check /> Criar usuário</button></Modal>}
  </>;
}

function SimplePage({ type }: { type: "users" | "settings" }) {
  return (
    <>
      <div className="page-actions">
        <div>
          <h2>
            {type === "users" ? "Usuários e permissões" : "Configurações"}
          </h2>
          <p>
            {type === "users"
              ? "Gerencie perfis e níveis de acesso."
              : "Personalize as regras e preferências da plataforma."}
          </p>
        </div>
        <button className="btn primary">
          <Plus />
          {type === "users" ? " Novo usuário" : " Nova configuração"}
        </button>
      </div>
      <section className="panel simple-settings">
        {type === "users" ? (
          <>
            <div className="user-row">
              <div className="avatar">DI</div>
              <span>
                <strong>Dirceu</strong>
                <small>admin@upe.br</small>
              </span>
              <Status>Em uso</Status>
              <em>Administrador</em>
            </div>
            <div className="user-row">
              <div className="avatar">NT</div>
              <span><strong>Equipe NTI</strong><small>nti@upe.br</small></span>
              <Status>Em uso</Status>
              <em>Chamados, patrimônio e manutenção</em>
            </div>
            <div className="user-row">
              <div className="avatar gold">AL</div>
              <span><strong>Aluno vistoriador</strong><small>aluno@upe.br</small></span>
              <Status>Em uso</Status>
              <em>Vistorias e consulta patrimonial</em>
            </div>
          </>
        ) : (
          [
            "Controle de acesso e RBAC",
            "Campos públicos de patrimônios",
            "Padrão das etiquetas de código de barras",
            "Notificações e alertas",
            "Integrações e dados em tempo real",
          ].map((x) => (
            <button key={x}>
              <Settings />
              <span>
                <strong>{x}</strong>
                <small>Configuração institucional</small>
              </span>
              <ChevronRight />
            </button>
          ))
        )}
      </section>
    </>
  );
}

function App() {
  const [now, setNow] = useState(() => new Date());
  const [assets, setAssets] = useState<Asset[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [maintenances, setMaintenances] = useState<Maintenance[]>([]);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [checklistTemplates, setChecklistTemplates] = useState<ChecklistTemplate[]>([]);
  const [user, setUser] = useState<SessionUser>(() => {
    try {
      return JSON.parse(sessionStorage.getItem("upe-user") || "null") || USERS.admin;
    } catch {
      return USERS.admin;
    }
  });
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"public" | "login" | "app">(() =>
    sessionStorage.getItem("upe-auth") ? "app" : "public",
  );
  const [page, setPage] = useState<Page>(() => user.role === "nti" ? "tickets" : user.role === "student" ? "inspections" : "dashboard");
  const [sidebar, setSidebar] = useState(false);
  const [globalQuery, setGlobalQuery] = useState("");
  const [transfer, setTransfer] = useState<Asset | null>(null);
  const [toast, setToast] = useState("");
  useEffect(() => {
    const syncClock = () => setNow(new Date());
    const interval = window.setInterval(syncClock, 30000);
    window.addEventListener("focus", syncClock);
    document.addEventListener("visibilitychange", syncClock);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", syncClock);
      document.removeEventListener("visibilitychange", syncClock);
    };
  }, []);
  useEffect(() => {
    (async () => {
      let stored = loadStore();
      if (hasApi() && sessionStorage.getItem("upe-auth")) {
        try {
          stored = await loadRemoteStore(user.role);
        } catch (cause) {
          console.error("Falha ao carregar dados da API; usando cache local.", cause);
        }
      }
      if (stored) {
        setAssets(stored.assets);
        setMovements(stored.movements || []);
        setLoans(stored.loans || []);
        setTickets(stored.tickets || []);
        setInspections(stored.inspections || []);
        setChecklistTemplates(stored.checklistTemplates?.length ? stored.checklistTemplates : buildChecklistTemplates(stored.assets));
        setMaintenances(
          stored.maintenances?.length
            ? stored.maintenances
            : buildMaintenanceItems(stored.assets),
        );
      } else {
        const importedAssets = await seedAssets();
        setAssets(importedAssets);
        setMaintenances(buildMaintenanceItems(importedAssets));
        setChecklistTemplates(buildChecklistTemplates(importedAssets));
      }
      setLoading(false);
    })();
  }, []);
  useEffect(() => {
    if (!loading && assets.length && !hasApi())
      saveStore({ assets, movements, loans, maintenances, tickets, inspections, checklistTemplates });
  }, [assets, movements, loans, maintenances, tickets, inspections, checklistTemplates, loading]);
  const notify = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3200);
  };
  const completeTransfer = async (
    room: string,
    sector: string,
    responsible: string,
    reason: string,
  ) => {
    if (!transfer) return;
    let m: Movement = {
      id: `move-${Date.now()}`,
      assetId: transfer.id,
      assetCode: transfer.code,
      assetName: transfer.name,
      from: transfer.room,
      to: room,
      previousResponsible: transfer.responsible,
      newResponsible: responsible,
      reason,
      user: user.name,
      createdAt: new Date().toISOString(),
    };
    if (hasApi()) {
      try { m = await api<Movement>(`/assets/${transfer.id}/transfer`, { method: "POST", body: JSON.stringify({ room, sector, responsible, reason }) }); }
      catch (cause) { notify(cause instanceof Error ? cause.message : "Falha ao registrar transferência."); return; }
    }
    setMovements([m, ...movements]);
    setAssets(
      assets.map((a) =>
        a.id === transfer.id
          ? {
              ...a,
              room,
              sector,
              responsible,
              updatedAt: new Date().toISOString(),
            }
          : a,
      ),
    );
    setTransfer(null);
    notify("Transferência registrada e indicadores atualizados.");
  };
  if (loading)
    return (
      <div className="loading">
        <Logo />
        <div />
        <p>Organizando o acervo patrimonial...</p>
      </div>
    );
  if (view === "public")
    return <PublicArea assets={assets} onLogin={() => setView("login")} onCreateTicket={async (ticket) => {
      let saved = ticket;
      if (hasApi()) {
        try { saved = await api<SupportTicket>("/public/tickets", { method: "POST", body: JSON.stringify(ticket) }); }
        catch (cause) { console.error(cause); }
      }
      setTickets([saved, ...tickets]);
    }} now={now} />;
  if (view === "login")
    return (
      <Login
        onBack={() => setView("public")}
        onSuccess={async (account) => {
          sessionStorage.setItem("upe-auth", "1");
          sessionStorage.setItem("upe-user", JSON.stringify(account));
          setUser(account);
          if (hasApi()) {
            try {
              const remote = await loadRemoteStore(account.role);
              setAssets(remote.assets); setMovements(remote.movements); setLoans(remote.loans);
              setMaintenances(remote.maintenances); setTickets(remote.tickets || []);
              setInspections(remote.inspections || []); setChecklistTemplates(remote.checklistTemplates || []);
            } catch (cause) { console.error(cause); }
          }
          setPage(account.role === "nti" ? "tickets" : account.role === "student" ? "inspections" : "dashboard");
          setView("app");
        }}
      />
    );
  const titles: Record<Page, string> = {
    dashboard: "Visão geral",
    assets: "Patrimônios",
    map: "Mapa patrimonial",
    inventory: "Inventário",
    movements: "Movimentações",
    loans: "Empréstimos",
    maintenance: "Manutenção",
    inspections: "Vistorias",
    "create-ticket": "Criar chamado",
    tickets: "Chamados",
    reports: "Relatórios",
    chat: "Assistente IA",
    users: "Usuários e permissões",
    settings: "Configurações",
  };
  const visibleAssets = user.role === "nti" ? assets.filter(isElectronicAsset) : assets;
  const canManageAssets = user.role === "admin" || user.role === "administration";
  let content: React.ReactNode;
  if (page === "dashboard")
    content = <Dashboard assets={assets} movements={movements} go={setPage} now={now} />;
  else if (page === "assets")
    content = (
      <AssetsPage
        assets={visibleAssets}
        setAssets={setAssets}
        initialQuery={globalQuery}
        onTransfer={setTransfer}
        canManage={canManageAssets}
      />
    );
  else if (page === "map")
    content = (
      <MapPage
        assets={assets}
        onOpen={(a) => {
          setPage("assets");
          setGlobalQuery(a.code);
        }}
      />
    );
  else if (page === "inventory") content = <InventoryPage assets={assets} now={now} />;
  else if (page === "movements")
    content = <MovementPage movements={movements} />;
  else if (page === "loans")
    content = (
      <LoansPage
        assets={assets}
        loans={loans}
        setLoans={setLoans}
        setAssets={setAssets}
      />
    );
  else if (page === "maintenance")
    content = (
      <MaintenancePage
        assets={assets}
        items={maintenances}
        setItems={setMaintenances}
        setAssets={setAssets}
        onNotify={notify}
        user={user}
      />
    );
  else if (page === "inspections")
    content = <InspectionsPage templates={checklistTemplates} inspections={inspections} setInspections={setInspections} user={user} onNotify={notify} now={now} />;
  else if (page === "create-ticket")
    content = <CreateTicketPage user={user} onCreated={(ticket) => setTickets([ticket, ...tickets])} onNotify={notify} />;
  else if (page === "tickets")
    content = <TicketsPage tickets={tickets} setTickets={setTickets} onNotify={notify} user={user} assets={assets} />;
  else if (page === "reports") content = <Reports assets={assets} />;
  else if (page === "chat")
    content = (
      <>
        <div className="page-actions">
          <div>
            <h2>Assistente IA</h2>
            <p>Faça perguntas em linguagem natural sobre o acervo.</p>
          </div>
        </div>
        <ChatPanel assets={assets} />
      </>
    );
  else if (page === "users") content = <UsersPage />;
  else content = <SimplePage type="settings" />;
  return (
    <div className="app-shell">
      <Sidebar
        page={page}
        setPage={setPage}
        open={sidebar}
        setOpen={setSidebar}
        maintenanceCount={maintenances.filter((item) => item.status !== "Concluído" && canMaintainItem(item, user, assets)).length}
        ticketCount={tickets.filter((item) => item.status !== "Resolvido" && canHandleTicket(item, user, assets)).length}
        user={user}
        logout={() => {
          sessionStorage.removeItem("upe-auth");
          sessionStorage.removeItem("upe-user");
          clearApiSession();
          setView("public");
        }}
      />
      <main className="app-main">
        <Topbar
          title={titles[page]}
          assets={visibleAssets}
          maintenances={maintenances}
          loans={loans}
          tickets={tickets}
          user={user}
          inspections={inspections}
          checklistTemplates={checklistTemplates}
          now={now}
          onNavigate={setPage}
          onMenu={() => setSidebar(true)}
          onSearch={(q) => {
            setGlobalQuery(q);
            if (q) setPage("assets");
          }}
        />
        <div className="content">{content}</div>
      </main>
      {transfer && (
        <TransferModal
          asset={transfer}
          onClose={() => setTransfer(null)}
          onSave={completeTransfer}
        />
      )}{" "}
      {toast && (
        <div className="toast">
          <Check />
          {toast}
        </div>
      )}
      <button
        className="reset-data"
        title="Restaurar dados da demonstração"
        onClick={() => {
          clearStore();
          location.reload();
        }}
      >
        <RotateCcw />
      </button>
    </div>
  );
}

export default App;
