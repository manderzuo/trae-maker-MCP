function Get-AiWorkDefaultGatewayBaseUrl {
    return 'https://api.gemstory.cn/v1'
}

function Normalize-AiWorkGatewayBaseUrl {
    param([Parameter(Mandatory = $true)][string]$BaseUrl)

    $candidate = $BaseUrl.Trim().TrimEnd('/')
    try {
        $uri = [Uri]$candidate
    } catch {
        throw 'Gateway base URL must be a valid absolute http/https URL.'
    }
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -notin @('http', 'https')) {
        throw 'Gateway base URL must be a valid absolute http/https URL.'
    }

    $builder = [UriBuilder]$uri
    if ($uri.Host -ieq 'www.gemstory.cn') {
        $builder.Host = 'api.gemstory.cn'
    }

    $path = $builder.Path.TrimEnd('/')
    if ($path -in @('/admin', '/admin/v1')) {
        $path = '/v1'
    } elseif ([string]::IsNullOrWhiteSpace($path) -or $path -eq '/') {
        $path = '/v1'
    } elseif ($path -notmatch '/v1$') {
        $path = "$path/v1"
    }

    $builder.Path = $path
    $builder.Query = ''
    $builder.Fragment = ''
    return $builder.Uri.AbsoluteUri.TrimEnd('/')
}
