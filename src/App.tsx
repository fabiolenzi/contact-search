import { useRef, useState } from 'react'
import Log from './Log'
import * as Excel from 'exceljs'

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

function App(): JSX.Element {
  const [selectedFile, setSelectedFile] = useState<File | undefined>(undefined)
  const [sheetLines, setSheetLines] = useState<number>(0)
  const [log, setLog] = useState<string[]>([])

  const workbook = useRef<Excel.Workbook>(new Excel.Workbook())
  const nameColumn = useRef<HTMLInputElement | null>(null)
  const telColumn = useRef<HTMLInputElement | null>(null)

  const CNPJ_REGEX = /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/

  const sleep = (seconds: number): Promise<void> => {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
  }

  const processSheet = async (): Promise<void> => {
    await getData()
    if (!workbook.current.getWorksheet(1)) return
    setSheetLines(workbook.current.getWorksheet(1).rowCount)

    for (const [index, row] of (
      workbook.current
        .getWorksheet(1)
        .getRows(1, workbook.current.getWorksheet(1).rowCount) as Excel.Row[]
    ).entries()) {
      const rowNumber = index + 1
      const cnpjCell = (row.values as Excel.CellValue[]).find((value: Excel.CellValue) =>
        CNPJ_REGEX.test(value?.toString() || '')
      )
      const cnpj: string | undefined = cnpjCell?.toString()
      if (cnpj) {
        const response = await fetchData(cnpj, rowNumber)
        if (workbook.current.getWorksheet(1)) {
          if (!nameColumn.current?.value || !telColumn.current?.value) return

          row.getCell(nameColumn.current.value.toUpperCase()).value = response[0]
          row.getCell(telColumn.current.value.toUpperCase()).value = response[1]
          row.commit()
        }
        await sleep(20)
      } else {
        setLog((oldLog) => [...oldLog, `CNPJ não encontrado na linha ${rowNumber}.`])
        await sleep(0.5)
      }
    }
  }

  const fetchData = async (cnpj: string, sheetLine: number): Promise<string[]> => {
    try {
      const response = await fetch(`https://receitaws.com.br/v1/cnpj/${cnpj.replace(/\D/g, '')}`)
      const data: company = await response.json()
      const name = getName(data.qsa as QSA[])
      const contact = getContact(data)
      setLog((oldLog) => [...oldLog, `Sucesso ao buscar dados na linha ${sheetLine}.`])
      return [name, contact]
    } catch (_) {
      setLog((oldLog) => [...oldLog, `Erro ao buscar dados na linha ${sheetLine}!`])
      return []
    }
  }

  const getName = (qsa: QSA[]): string => {
    const firstQual = '49-Sócio-Administrador'
    const secondQual = '05-Administrador'

    const name = qsa.find((person) => person.qual == firstQual || person.qual == secondQual)?.nome
    return name ?? ''
  }

  const getContact = (data: company): string => {
    return `${data.telefone} - ${data.municipio}/${data.uf}`
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
    <div className="container">
      <h1>CONTACT SEARCH</h1>
      <input
        className="file"
        type="file"
        onChange={(e): void => handleChange(e.target.files)}
        accept=".csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel"
      />
      <div className="fields">
        <div className="column-field">
          <label htmlFor="">Coluna para nome do sócio:</label>
          <input
            ref={nameColumn}
            type="text"
            name="name"
            id="name"
            maxLength={2}
            pattern="[A-Za-z]"
          />
        </div>
        <div className="column-field">
          <label htmlFor="">Coluna para telefone:</label>
          <input ref={telColumn} type="text" name="tel" id="tel" />
        </div>
      </div>
      <div className="buttons">
        <button onClick={processSheet} disabled={!selectedFile}>
          Buscar contatos
        </button>
        <button onClick={exportSheet} disabled={!selectedFile}>
          Exportar planilha
        </button>
      </div>
      {sheetLines > 0 ? <span>{`${log.length} de ${sheetLines} linhas processadas`}</span> : <></>}
      <Log entries={log} />
    </div>
  )
}

export default App
