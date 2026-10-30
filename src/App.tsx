import { useEffect, useRef, useState } from 'react'
import Log from './Log'
import * as Excel from 'exceljs'
import './App.css'

interface QSA {
  nome: string
  qual: string
}

interface company {
  municipio: string
  telefone: string
  uf: string
  qsa: QSA[]
}

interface SavedSettings {
  nameColumn: string
  telColumn: string
  phoneMode: 'joined' | 'split'
  cityColumn: string
  hasFilter: boolean
  filterColumn: string
  filterValue: string
}

const SETTINGS_KEY = 'contact-search-settings'
const DEFAULT_SETTINGS: SavedSettings = {
  nameColumn: '',
  telColumn: '',
  phoneMode: 'split',
  cityColumn: '',
  hasFilter: false,
  filterColumn: '',
  filterValue: '',
}

const readSettings = (): SavedSettings => {
  try {
    const savedSettings = localStorage.getItem(SETTINGS_KEY)
    return savedSettings ? { ...DEFAULT_SETTINGS, ...JSON.parse(savedSettings) } : DEFAULT_SETTINGS
  } catch {
    return DEFAULT_SETTINGS
  }
}

function App(): JSX.Element {
  const [selectedFile, setSelectedFile] = useState<File | undefined>(undefined)
  const [sheetLines, setSheetLines] = useState<number>(0)
  const [log, setLog] = useState<string[]>([])
  const [nextRequestIn, setNextRequestIn] = useState<number | null>(null)
  const [settings, setSettings] = useState<SavedSettings>(readSettings)

  const workbook = useRef<Excel.Workbook>(new Excel.Workbook())

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch {
      // Keep the form usable when browser storage is unavailable.
    }
  }, [settings])

  const CNPJ_REGEX = /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/

  const sleep = (seconds: number): Promise<void> => {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
  }

  const waitForNextRequest = async (delaySeconds = 20): Promise<void> => {
    for (let seconds = delaySeconds; seconds > 0; seconds -= 1) {
      setNextRequestIn(seconds)
      await sleep(1)
    }
    setNextRequestIn(null)
  }

  const getRetryDelay = (retryAfter: string | null): number => {
    if (!retryAfter) return 20

    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds)) return Math.max(1, Math.ceil(seconds))

    const retryAt = Date.parse(retryAfter)
    if (Number.isNaN(retryAt)) return 20
    return Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))
  }

  const processSheet = async (): Promise<void> => {
    await getData()
    const worksheet = workbook.current.getWorksheet(1)
    if (!worksheet) return
    setSheetLines(worksheet.rowCount)

    const rows = worksheet.getRows(1, worksheet.rowCount) as Excel.Row[]
    for (const [index, row] of rows.entries()) {
      const rowNumber = index + 1
      const cnpjCell = (row.values as Excel.CellValue[]).find((value: Excel.CellValue) =>
        CNPJ_REGEX.test(value?.toString() || '')
      )
      const cnpj: string | undefined = cnpjCell?.toString()
      if (cnpj) {
        const amount = getValueToFilter(row)
        const minimumValue = Number(settings.filterValue)
        if (settings.hasFilter && amount !== null && settings.filterValue !== '' && amount < minimumValue) {
          setLog((oldLog) => [...oldLog, `Linha ${rowNumber} não atinge valor mínimo.`])
          await sleep(0.5)
        } else {
          const response = await fetchData(cnpj, rowNumber)
          writeData(row, response)
          const hasNextRequest = rows.slice(index + 1).some((nextRow) => {
            const nextCnpj = (nextRow.values as Excel.CellValue[]).find((value: Excel.CellValue) =>
              CNPJ_REGEX.test(value?.toString() || '')
            )
            if (!nextCnpj) return false

            const nextAmount = getValueToFilter(nextRow)
            return !(settings.hasFilter && nextAmount !== null && settings.filterValue !== '' && nextAmount < minimumValue)
          })
          if (hasNextRequest) await waitForNextRequest()
      }
      } else {
        setLog((oldLog) => [...oldLog, `CNPJ não encontrado na linha ${rowNumber}.`])
        await sleep(0.5)
      }
    }
  }

  const fetchData = async (cnpj: string, sheetLine: number): Promise<string[]> => {
    for (let retry = 0; retry <= 2; retry += 1) {
      try {
        const response = await fetch(`https://receitaws.com.br/v1/cnpj/${cnpj.replace(/\D/g, '')}`)
        if (response.status === 429) {
          if (retry === 2) {
            setLog((oldLog) => [...oldLog, `Erro ao buscar dados na linha ${sheetLine}: HTTP 429 após 3 tentativas.`])
            return []
          }

          const delay = getRetryDelay(response.headers.get('Retry-After'))
          setLog((oldLog) => [...oldLog, `Limite de requisições na linha ${sheetLine}. Nova tentativa ${retry + 1}/2 em ${delay}s.`])
          await waitForNextRequest(delay)
          continue
        }

        const data: company = await response.json()
        const name = getName(data.qsa as QSA[])
        setLog((oldLog) => [...oldLog, `Sucesso ao buscar dados na linha ${sheetLine}.`])
        return [name, data.telefone ?? '', data.municipio ?? '']
      } catch (_) {
        setLog((oldLog) => [...oldLog, `Erro ao buscar dados na linha ${sheetLine}!`])
        return []
      }
    }

    return []
  }

  const writeData = (row: Excel.Row, data: string[]) => {
    if (data.length < 3 || !settings.nameColumn || !settings.telColumn || !settings.cityColumn) return

    const phoneNumbers = data[1].split('/').map((phone) => phone.trim()).filter(Boolean)
    const phoneValue = settings.phoneMode === 'split'
      ? phoneNumbers[0] ?? ''
      : data[1].trim()
    const columns = [
      settings.nameColumn,
      settings.telColumn,
      settings.cityColumn,
    ]
    writeGroupedData(row, [data[0], phoneValue, data[2]], columns)

    if (settings.phoneMode === 'split' && phoneNumbers.length > 1) {
      const reservedColumns = new Set(
        [settings.nameColumn, settings.telColumn, settings.cityColumn]
          .map((column) => column.toUpperCase())
      )
      if (settings.hasFilter && settings.filterColumn) {
        reservedColumns.add(settings.filterColumn.toUpperCase())
      }
      const firstEmptyColumn = columnLettersToNumber(settings.telColumn.toUpperCase()) + 1
      writePhonesToEmptyColumns(row, phoneNumbers.slice(1), firstEmptyColumn, reservedColumns)
    }

    row.commit()
  }

  const writePhonesToEmptyColumns = (
    row: Excel.Row,
    phones: string[],
    startColumn: number,
    reservedColumns: Set<string>,
  ) => {
    let columnNumber = startColumn
    for (const phone of phones) {
      while (columnNumber <= 16384) {
        const column = columnNumberToLetters(columnNumber)
        const cell = row.getCell(columnNumber)
        columnNumber += 1

        if (reservedColumns.has(column)) continue
        if (cell.value !== null && cell.value !== undefined && cell.value !== '') continue

        cell.value = phone
        break
      }
    }
  }

  const columnLettersToNumber = (letters: string): number => {
    return letters.split('').reduce((number, letter) => number * 26 + letter.charCodeAt(0) - 64, 0)
  }

  const columnNumberToLetters = (columnNumber: number): string => {
    let number = columnNumber
    let letters = ''
    while (number > 0) {
      const remainder = (number - 1) % 26
      letters = String.fromCharCode(65 + remainder) + letters
      number = Math.floor((number - 1) / 26)
    }
    return letters
  }

  const writeGroupedData = (row: Excel.Row, data: string[], columns: string[]) => {
    const valuesByColumn = new Map<string, string[]>()

    columns.forEach((column, index) => {
      const normalizedColumn = column.toUpperCase()
      const values = valuesByColumn.get(normalizedColumn) ?? []
      values.push(data[index])
      valuesByColumn.set(normalizedColumn, values)
    })

    valuesByColumn.forEach((values, column) => {
      row.getCell(column).value = values.filter(Boolean).join(' - ')
    })
  }

  const getValueToFilter = (row: Excel.Row): number | null => {
    if (!settings.hasFilter || !settings.filterColumn) {
      return null;
    }

    return row.getCell(settings.filterColumn.toUpperCase()).value as number ?? null;
  } 

  const getName = (qsa: QSA[]): string => {
    const firstQual = '49-Sócio-Administrador'
    const secondQual = '05-Administrador'

    const name = qsa.find((person) => person.qual == firstQual || person.qual == secondQual)?.nome
    return name ?? ''
  }

  const getData = async (): Promise<void> => {
    if (selectedFile) {
      await workbook.current.xlsx.load(await selectedFile.arrayBuffer())
    }
  }

  const handleChange = (selectorFiles: FileList | null): void => {
    if (selectorFiles && selectorFiles[0]) {
      setSelectedFile(selectorFiles[0])
    }
  }

  const exportSheet = (): void => {
    if (!workbook.current.getWorksheet(1)) return
    workbook.current.xlsx.writeBuffer().then((data) => {
      const blob = new Blob([data])

      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      document.body.appendChild(a)
      a.href = url
      a.download = 'planilha.xlsx'
      a.click()
      window.URL.revokeObjectURL(url)
    })
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="./" aria-label="Contact Search início">
          <span className="brand-mark" aria-hidden="true">C</span>
          <span>contact<span className="brand-light">search</span></span>
        </a>
        <span className="topbar-note"><span className="status-dot" /> Ferramenta de prospecção</span>
      </header>

      <section className="intro">
        <div className="eyebrow">ENRIQUECIMENTO DE DADOS</div>
        <h1>Encontre os contatos<br /><span>certos para sua empresa.</span></h1>
        <p>Envie sua planilha e complete os dados de contato dos sócios em poucos passos.</p>
      </section>

      <section className="workspace" aria-label="Configuração da busca">
        <div className="step-heading">
          <span className="step-number">01</span>
          <div><h2>Sua planilha</h2><p>Escolha o arquivo que deseja processar.</p></div>
        </div>
        <label className={`upload-box${selectedFile ? ' has-file' : ''}`} htmlFor="spreadsheet">
          <input
            id="spreadsheet"
            type="file"
            onChange={(e): void => handleChange(e.target.files)}
            accept=".csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel"
          />
          <span className="upload-icon" aria-hidden="true">↑</span>
          <span className="upload-copy">
            <strong>{selectedFile ? selectedFile.name : 'Clique para escolher sua planilha'}</strong>
            <small>{selectedFile ? 'Arquivo pronto para processar' : 'CSV ou Excel · XLS, XLSX'}</small>
          </span>
          <span className="browse-button">Procurar arquivo</span>
        </label>

        <div className="section-divider" />
        <div className="step-heading">
          <span className="step-number">02</span>
          <div><h2>Onde salvar os dados</h2><p>Informe a letra de cada coluna na planilha.</p></div>
        </div>
        <div className="destination-grid">
          <div className="column-field">
            <label htmlFor="name">Nome do sócio</label>
            <div className="column-input-wrap"><input value={settings.nameColumn} onChange={(event) => setSettings({ ...settings, nameColumn: event.target.value.toUpperCase() })} type="text" name="name" id="name" maxLength={3} pattern="[A-Za-z]+" placeholder="Ex.: D" /><span>COLUNA</span></div>
          </div>
          <div className="column-field">
            <label htmlFor="tel">Telefone</label>
            <div className="column-input-wrap"><input value={settings.telColumn} onChange={(event) => setSettings({ ...settings, telColumn: event.target.value.toUpperCase() })} type="text" name="tel" id="tel" maxLength={3} pattern="[A-Za-z]+" placeholder="Ex.: E" /><span>COLUNA</span></div>
          </div>
          <div className="column-field">
            <label htmlFor="city">Município</label>
            <div className="column-input-wrap"><input value={settings.cityColumn} onChange={(event) => setSettings({ ...settings, cityColumn: event.target.value.toUpperCase() })} type="text" name="city" id="city" maxLength={3} pattern="[A-Za-z]+" placeholder="Ex.: F" /><span>COLUNA</span></div>
          </div>
        </div>

        <fieldset className="phone-mode-options">
          <legend>Como salvar vários telefones?</legend>
          <label htmlFor="phoneModeJoined">
            <input
              checked={settings.phoneMode === 'joined'}
              id="phoneModeJoined"
              name="phoneMode"
              onChange={() => setSettings({ ...settings, phoneMode: 'joined' })}
              type="radio"
              value="joined"
            />
            <span><strong>Manter juntos</strong><small>Todos os números em uma célula.</small></span>
          </label>
          <label htmlFor="phoneModeSplit">
            <input
              checked={settings.phoneMode === 'split'}
              id="phoneModeSplit"
              name="phoneMode"
              onChange={() => setSettings({ ...settings, phoneMode: 'split' })}
              type="radio"
              value="split"
            />
            <span><strong>Separar em células</strong><small>Um número por coluna vazia, a partir da próxima.</small></span>
          </label>
        </fieldset>

        <div className={`filter-panel${settings.hasFilter ? ' is-enabled' : ''}`}>
          <label className="filter-toggle" htmlFor="hasFilter">
            <input checked={settings.hasFilter} type="checkbox" name="hasFilter" id="hasFilter" onChange={(event) => setSettings({ ...settings, hasFilter: event.target.checked })} />
            <span className="custom-check" aria-hidden="true" />
            <span><strong>Aplicar filtro de valor mínimo</strong><small>Processar apenas empresas acima do valor informado.</small></span>
          </label>
          <div className="filter-fields">
            <div className="column-field">
              <label htmlFor="filterColumn">Coluna do valor</label>
              <input value={settings.filterColumn} onChange={(event) => setSettings({ ...settings, filterColumn: event.target.value.toUpperCase() })} type="text" name="filterColumn" id="filterColumn" maxLength={3} pattern="[A-Za-z]+" placeholder="Ex.: G" disabled={!settings.hasFilter} />
            </div>
            <div className="amount-field">
              <label htmlFor="filterValue">Valor mínimo</label>
              <input value={settings.filterValue} onChange={(event) => setSettings({ ...settings, filterValue: event.target.value })} type="number" name="filterValue" id="filterValue" placeholder="R$ 0,00" disabled={!settings.hasFilter} />
            </div>
          </div>
        </div>

        <div className="actions">
          <button className="primary-button" onClick={processSheet} disabled={!selectedFile}><span aria-hidden="true">⌕</span> Buscar contatos</button>
          <button className="secondary-button" onClick={exportSheet} disabled={!selectedFile}><span aria-hidden="true">↓</span> Exportar planilha</button>
        </div>
      </section>

      {(sheetLines > 0 || log.length > 0) && (
        <section className="results-card" aria-label="Atividade">
          <div className="results-heading"><div><span className="eyebrow">ACOMPANHAMENTO</span><h2>Atividade recente</h2></div>{sheetLines > 0 && <span className="progress-count">{log.length} <span>/ {sheetLines} linhas</span></span>}</div>
          {nextRequestIn !== null && (
            <div className="request-countdown" role="status" aria-live="polite">
              <span className="countdown-pulse" aria-hidden="true" />
              <span>Próxima consulta em</span>
              <strong>{nextRequestIn}s</strong>
            </div>
          )}
          <Log entries={log} />
        </section>
      )}
      <footer className="app-footer"><span>CONTACT SEARCH</span><span>Dados empresariais, organizados para você.</span></footer>
    </main>
  )
}

export default App
